/**
 * ReAct loop engine adapter — a pure TypeScript implementation of the
 * EngineAdapter contract that runs a Reason + Act cycle.
 *
 * The adapter calls the model, checks for tool calls in the response metadata,
 * executes them in parallel, appends results to the conversation, and repeats
 * until the model produces a final text response or maxTurns is reached.
 */

import type {
  ComposedCallHandlers,
  ContentBlock,
  EngineAdapter,
  EngineCapabilities,
  EngineEvent,
  EngineInput,
  EngineMetrics,
  EngineOutput,
  EngineState,
  EngineStopReason,
  InboundMessage,
  JsonObject,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolHandler,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { toolCallId } from "@koi/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 25 as const;
const ENGINE_ID = "koi-loop" as const;

/**
 * Loop adapter capabilities — passes through to the model call handler.
 * The model handler's own capabilities determine actual support, so we
 * declare full content support here.
 */
const LOOP_CAPABILITIES: EngineCapabilities = {
  text: true,
  images: true,
  files: true,
  audio: false,
} as const;

export interface LoopAdapterConfig {
  /** Raw model call terminal — the actual LLM call function. */
  readonly modelCall: ModelHandler;
  /** Raw model stream terminal — optional streaming LLM call. */
  readonly modelStream?: ModelStreamHandler;
  /** Raw tool call terminal — optional, falls back to callHandlers. */
  readonly toolCall?: ToolHandler;
  /** Maximum number of ReAct loop iterations. Default: 25. */
  readonly maxTurns?: number;
}

// ---------------------------------------------------------------------------
// Tool call metadata shape
// ---------------------------------------------------------------------------

interface ToolCallDescriptor {
  readonly toolName: string;
  readonly callId: string;
  readonly input: JsonObject;
}

/**
 * Type guard for tool call descriptors found in ModelResponse.metadata.toolCalls.
 */
function isToolCallArray(value: unknown): value is readonly ToolCallDescriptor[] {
  if (!Array.isArray(value)) return false;
  return value.every((item: unknown) => {
    if (typeof item !== "object" || item === null) return false;
    const record = item as Record<string, unknown>;
    return (
      "toolName" in record &&
      typeof record.toolName === "string" &&
      "callId" in record &&
      typeof record.callId === "string" &&
      "input" in record &&
      typeof record.input === "object" &&
      record.input !== null
    );
  });
}

/**
 * Extract tool calls from a model response's metadata, if any.
 */
function extractToolCalls(response: ModelResponse): readonly ToolCallDescriptor[] {
  if (response.metadata === undefined) return [];
  const toolCalls: unknown = response.metadata.toolCalls;
  if (toolCalls === undefined) return [];
  if (!isToolCallArray(toolCalls)) return [];
  return toolCalls;
}

// ---------------------------------------------------------------------------
// Input conversion helpers
// ---------------------------------------------------------------------------

/**
 * Converts engine input into a mutable message array for the loop.
 * Always returns a fresh array so the loop can safely push onto it.
 */
function inputToMutableMessages(input: EngineInput): InboundMessage[] {
  switch (input.kind) {
    case "text":
      return [
        {
          content: [{ kind: "text" as const, text: input.text }],
          senderId: "user",
          timestamp: Date.now(),
        },
      ];
    case "messages":
      return [...input.messages];
    case "resume":
      return [...extractMessagesFromState(input.state)];
  }
}

/**
 * Type guard: validates that a value structurally conforms to InboundMessage.
 */
function isInboundMessage(value: unknown): value is InboundMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.content) &&
    typeof record.senderId === "string" &&
    typeof record.timestamp === "number"
  );
}

function extractMessagesFromState(state: EngineState): readonly InboundMessage[] {
  if (typeof state.data !== "object" || state.data === null || !("messages" in state.data)) {
    return [];
  }
  const record = state.data as Record<string, unknown>;
  if (!Array.isArray(record.messages)) return [];
  return record.messages.filter(isInboundMessage);
}

// ---------------------------------------------------------------------------
// Metrics accumulator (immutable)
// ---------------------------------------------------------------------------

interface MetricsAccumulator {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turns: number;
  readonly startTime: number;
}

function createMetricsAccumulator(): MetricsAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
    startTime: Date.now(),
  };
}

function addModelUsage(acc: MetricsAccumulator, response: ModelResponse): MetricsAccumulator {
  const usage = response.usage;
  if (usage === undefined) return acc;
  return {
    ...acc,
    inputTokens: acc.inputTokens + usage.inputTokens,
    outputTokens: acc.outputTokens + usage.outputTokens,
  };
}

function incrementTurn(acc: MetricsAccumulator): MetricsAccumulator {
  return { ...acc, turns: acc.turns + 1 };
}

function finalizeMetrics(acc: MetricsAccumulator): EngineMetrics {
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    totalTokens: acc.inputTokens + acc.outputTokens,
    turns: acc.turns,
    durationMs: Date.now() - acc.startTime,
  };
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeToolCall(
  descriptor: ToolCallDescriptor,
  toolHandler: ToolHandler,
  signal?: AbortSignal,
): Promise<{ readonly descriptor: ToolCallDescriptor; readonly response: ToolResponse }> {
  const request: ToolRequest = {
    toolId: descriptor.toolName,
    input: descriptor.input,
    ...(signal !== undefined ? { signal } : {}),
  };
  try {
    const response = await toolHandler(request);
    return { descriptor, response };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      descriptor,
      response: { output: `Tool execution error: ${message}` },
    };
  }
}

// ---------------------------------------------------------------------------
// Tool round execution (shared by streaming + non-streaming paths)
// ---------------------------------------------------------------------------

async function executeToolRound(
  toolCalls: readonly ToolCallDescriptor[],
  toolHandler: ToolHandler | undefined,
  emitStartEvents: boolean,
  signal?: AbortSignal,
): Promise<{
  readonly results: readonly {
    readonly descriptor: ToolCallDescriptor;
    readonly response: ToolResponse;
  }[];
  readonly events: readonly EngineEvent[];
}> {
  if (toolHandler === undefined) {
    throw new Error(
      "Model returned tool calls but no tool handler is available. " +
        "Provide a toolCall terminal or ensure callHandlers include toolCall.",
    );
  }

  const events: EngineEvent[] = [];

  // Non-streaming: emit tool_call_start before execution.
  // Streaming: already emitted by the stream, so skip.
  if (emitStartEvents) {
    for (const tc of toolCalls) {
      events.push({
        kind: "tool_call_start" as const,
        toolName: tc.toolName,
        callId: toolCallId(tc.callId),
        args: tc.input,
      });
    }
  }

  const results = await Promise.all(
    toolCalls.map((tc) => executeToolCall(tc, toolHandler, signal)),
  );

  for (const result of results) {
    events.push({
      kind: "tool_call_end" as const,
      callId: toolCallId(result.descriptor.callId),
      result: result.response.output,
    });
  }

  return { results, events };
}

// ---------------------------------------------------------------------------
// Message building helpers (mutate-in-place for O(1) append in hot loop)
// ---------------------------------------------------------------------------

function buildAssistantMessage(content: string, metadata?: JsonObject): InboundMessage {
  return {
    content: [{ kind: "text" as const, text: content }],
    senderId: "assistant",
    timestamp: Date.now(),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function buildToolResultMessages(
  results: readonly { readonly descriptor: ToolCallDescriptor; readonly response: ToolResponse }[],
): readonly InboundMessage[] {
  return results.map((r) => ({
    content: [
      {
        kind: "text" as const,
        text:
          typeof r.response.output === "string"
            ? r.response.output
            : JSON.stringify(r.response.output),
      },
    ],
    senderId: "tool",
    timestamp: Date.now(),
    metadata: {
      toolName: r.descriptor.toolName,
      callId: r.descriptor.callId,
    },
  }));
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

async function* streamModelAndCollect(
  streamHandler: ModelStreamHandler,
  request: ModelRequest,
): AsyncGenerator<
  | { readonly kind: "event"; readonly event: EngineEvent }
  | { readonly kind: "response"; readonly response: ModelResponse },
  void,
  undefined
> {
  // let: set once when the stream emits the done chunk
  let finalResponse: ModelResponse | undefined;

  for await (const chunk of streamHandler(request)) {
    switch (chunk.kind) {
      case "text_delta":
        yield {
          kind: "event" as const,
          event: { kind: "text_delta" as const, delta: chunk.delta },
        };
        break;
      case "tool_call_start":
        yield {
          kind: "event" as const,
          event: {
            kind: "tool_call_start" as const,
            toolName: chunk.toolName,
            callId: chunk.callId,
          },
        };
        break;
      case "tool_call_delta":
        yield {
          kind: "event" as const,
          event: {
            kind: "tool_call_delta" as const,
            callId: chunk.callId,
            delta: chunk.delta,
          },
        };
        break;
      case "tool_call_end":
        // tool_call_end from streaming doesn't carry result — the result comes from tool execution
        break;
      case "done":
        finalResponse = chunk.response;
        break;
      // thinking_delta, usage — internal, not forwarded as EngineEvent
      default:
        break;
    }
  }

  if (finalResponse !== undefined) {
    yield { kind: "response" as const, response: finalResponse };
  }
}

/**
 * Consume a model stream and return the final ModelResponse, discarding chunks.
 * Used for the max_turns summary call where we only need the final response.
 */
async function collectStreamResponse(
  streamHandler: ModelStreamHandler,
  request: ModelRequest,
): Promise<ModelResponse | undefined> {
  // let: set once when the stream emits the done chunk
  let finalResponse: ModelResponse | undefined;
  for await (const chunk of streamHandler(request)) {
    if (chunk.kind === "done") {
      finalResponse = chunk.response;
    }
  }
  return finalResponse;
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Creates a ReAct loop engine adapter.
 *
 * The adapter runs a Reason + Act cycle: call the model, check for tool calls,
 * execute them in parallel, append results, and repeat until the model produces
 * a final text response or maxTurns is reached.
 */
export function createLoopAdapter(config: LoopAdapterConfig): EngineAdapter {
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  // let: toggled once by dispose() — lifecycle flag
  let disposed = false;
  // let: guards against concurrent runs sharing mutable savedMessages
  let running = false;

  // Resolve which handlers to use: prefer callHandlers (middleware-composed),
  // fall back to raw terminals.
  function resolveModelCall(callHandlers: ComposedCallHandlers | undefined): ModelHandler {
    if (callHandlers !== undefined) return callHandlers.modelCall;
    return config.modelCall;
  }

  function resolveModelStream(
    callHandlers: ComposedCallHandlers | undefined,
  ): ModelStreamHandler | undefined {
    if (callHandlers?.modelStream !== undefined) return callHandlers.modelStream;
    return config.modelStream;
  }

  function resolveToolCall(
    callHandlers: ComposedCallHandlers | undefined,
  ): ToolHandler | undefined {
    if (callHandlers !== undefined) return callHandlers.toolCall;
    return config.toolCall;
  }

  // The ReAct loop
  async function* runLoop(input: EngineInput): AsyncGenerator<EngineEvent, void, undefined> {
    if (running) {
      throw new Error(
        "LoopAdapter does not support concurrent runs. Wait for the current run to complete.",
      );
    }
    running = true;

    try {
      const callHandlers = input.callHandlers;
      const modelCall = resolveModelCall(callHandlers);
      const toolHandler = resolveToolCall(callHandlers);
      const modelStream = resolveModelStream(callHandlers);
      const signal = input.signal;

      // Mutable array — local to this generator, never shared during iteration.
      // Uses push() for O(1) append instead of O(n) spread per turn.
      const messages: InboundMessage[] = inputToMutableMessages(input);
      // let: accumulated immutably via reassignment each turn
      let metrics = createMetricsAccumulator();
      let stopReason: EngineStopReason = "completed";

      for (let turn = 0; turn < maxTurns; turn++) {
        if (disposed) {
          stopReason = "interrupted";
          break;
        }

        // Check abort signal before each model call
        if (signal?.aborted) {
          stopReason = "interrupted";
          break;
        }

        const request: ModelRequest = {
          messages,
          ...(signal !== undefined ? { signal } : {}),
        };

        // --- Get model response (streaming or non-streaming) ---
        let response: ModelResponse | undefined;

        if (modelStream !== undefined) {
          for await (const item of streamModelAndCollect(modelStream, request)) {
            if (item.kind === "event") {
              yield item.event;
            } else {
              response = item.response;
            }
          }
          if (response === undefined) {
            stopReason = "error";
            metrics = incrementTurn(metrics);
            yield { kind: "turn_end" as const, turnIndex: turn };
            break;
          }
        } else {
          response = await modelCall(request);
        }

        metrics = addModelUsage(metrics, response);
        const toolCalls = extractToolCalls(response);

        // --- No tool calls: final response ---
        if (toolCalls.length === 0) {
          if (modelStream === undefined && response.content.length > 0) {
            yield { kind: "text_delta" as const, delta: response.content };
          }
          messages.push(buildAssistantMessage(response.content, response.metadata));
          metrics = incrementTurn(metrics);
          yield { kind: "turn_end" as const, turnIndex: turn };
          break;
        }

        // --- Tool calls: execute round and continue loop ---
        const { results, events } = await executeToolRound(
          toolCalls,
          toolHandler,
          modelStream === undefined,
          signal,
        );
        for (const event of events) yield event;

        messages.push(buildAssistantMessage(response.content, response.metadata));
        messages.push(...buildToolResultMessages(results));
        metrics = incrementTurn(metrics);
        yield { kind: "turn_end" as const, turnIndex: turn };

        if (turn === maxTurns - 1) {
          stopReason = "max_turns";
        }
      }

      // When max_turns is hit after a tool round, the last message is a tool result.
      // Do one final model call to produce a proper text response so the output
      // reflects the model's synthesis rather than raw tool output.
      if (stopReason === "max_turns") {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg !== undefined && lastMsg.senderId === "tool") {
          if (!signal?.aborted && !disposed) {
            const finalRequest: ModelRequest = {
              messages,
              ...(signal !== undefined ? { signal } : {}),
            };
            try {
              const summaryResponse =
                modelStream !== undefined
                  ? await collectStreamResponse(modelStream, finalRequest)
                  : await modelCall(finalRequest);
              if (summaryResponse !== undefined) {
                metrics = addModelUsage(metrics, summaryResponse);
                messages.push(
                  buildAssistantMessage(summaryResponse.content, summaryResponse.metadata),
                );
              }
            } catch {
              // If the final summary call fails, fall through to use existing content.
              // The stop reason already indicates max_turns — the caller knows the output
              // may be incomplete.
            }
          }
        }
      }

      // Build final output
      const lastMessage = messages[messages.length - 1];
      const finalContent: readonly ContentBlock[] =
        lastMessage !== undefined ? lastMessage.content : [];

      const output: EngineOutput = {
        content: finalContent,
        stopReason,
        metrics: finalizeMetrics(metrics),
      };

      // Persist final conversation state for saveState()
      savedMessages = messages;

      yield { kind: "done" as const, output };
    } finally {
      running = false;
    }
  }

  // let: updated at end of each runLoop execution for state persistence
  let savedMessages: readonly InboundMessage[] = [];

  const adapter: EngineAdapter = {
    engineId: ENGINE_ID,
    capabilities: LOOP_CAPABILITIES,

    terminals: {
      modelCall: config.modelCall,
      ...(config.modelStream !== undefined ? { modelStream: config.modelStream } : {}),
      ...(config.toolCall !== undefined ? { toolCall: config.toolCall } : {}),
    },

    stream: (input: EngineInput): AsyncIterable<EngineEvent> => {
      return runLoop(input);
    },

    saveState: async (): Promise<EngineState> => {
      return {
        engineId: ENGINE_ID,
        data: { messages: savedMessages },
      };
    },

    loadState: async (state: EngineState): Promise<void> => {
      if (state.engineId !== ENGINE_ID) {
        throw new Error(`Cannot load state from engine "${state.engineId}" into "${ENGINE_ID}"`);
      }
      savedMessages = extractMessagesFromState(state);
    },

    dispose: async (): Promise<void> => {
      // Idempotent
      disposed = true;
    },
  };

  return adapter;
}
