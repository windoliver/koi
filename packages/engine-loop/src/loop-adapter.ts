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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 25 as const;
const ENGINE_ID = "koi-loop" as const;

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
): Promise<{ readonly descriptor: ToolCallDescriptor; readonly response: ToolResponse }> {
  const request: ToolRequest = {
    toolId: descriptor.toolName,
    input: descriptor.input,
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
            args: {},
          },
        };
        break;
      case "tool_call_end":
        // tool_call_end from streaming doesn't carry result — the result comes from tool execution
        break;
      case "done":
        finalResponse = chunk.response;
        break;
      // thinking_delta, tool_call_delta, usage — internal, not forwarded as EngineEvent
      default:
        break;
    }
  }

  if (finalResponse !== undefined) {
    yield { kind: "response" as const, response: finalResponse };
  }
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

  // The ReAct loop — non-streaming path
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

        const request: ModelRequest = { messages };

        // Decide: stream or call
        if (modelStream !== undefined) {
          // Streaming path
          let response: ModelResponse | undefined;

          for await (const item of streamModelAndCollect(modelStream, request)) {
            if (item.kind === "event") {
              yield item.event;
            } else {
              response = item.response;
            }
          }

          if (response === undefined) {
            // Stream ended without a done chunk — unexpected. Build a minimal response.
            stopReason = "error";
            metrics = incrementTurn(metrics);
            yield { kind: "turn_end" as const, turnIndex: turn };
            break;
          }

          metrics = addModelUsage(metrics, response);

          // Check for tool calls
          const toolCalls = extractToolCalls(response);

          if (toolCalls.length === 0) {
            // No tool calls — final response
            // text_delta events were already yielded by streaming
            messages.push(buildAssistantMessage(response.content, response.metadata));
            metrics = incrementTurn(metrics);
            yield { kind: "turn_end" as const, turnIndex: turn };
            break;
          }

          // Execute tool calls in parallel
          if (toolHandler === undefined) {
            throw new Error(
              "Model returned tool calls but no tool handler is available. " +
                "Provide a toolCall terminal or ensure callHandlers include toolCall.",
            );
          }

          const toolResults = await Promise.all(
            toolCalls.map((tc) => {
              // Emit tool_call_start for non-streaming tool calls
              // (streaming already emitted tool_call_start via ModelChunk)
              return executeToolCall(tc, toolHandler);
            }),
          );

          // Emit tool_call_end events for each result
          for (const result of toolResults) {
            yield {
              kind: "tool_call_end" as const,
              callId: result.descriptor.callId,
              result: result.response.output,
            };
          }

          messages.push(buildAssistantMessage(response.content, response.metadata));
          messages.push(...buildToolResultMessages(toolResults));
          metrics = incrementTurn(metrics);
          yield { kind: "turn_end" as const, turnIndex: turn };
        } else {
          // Non-streaming path
          const response = await modelCall(request);
          metrics = addModelUsage(metrics, response);

          // Check for tool calls
          const toolCalls = extractToolCalls(response);

          if (toolCalls.length === 0) {
            // No tool calls — emit text_delta and done
            if (response.content.length > 0) {
              yield { kind: "text_delta" as const, delta: response.content };
            }
            messages.push(buildAssistantMessage(response.content, response.metadata));
            metrics = incrementTurn(metrics);
            yield { kind: "turn_end" as const, turnIndex: turn };
            break;
          }

          // Execute tool calls in parallel
          if (toolHandler === undefined) {
            throw new Error(
              "Model returned tool calls but no tool handler is available. " +
                "Provide a toolCall terminal or ensure callHandlers include toolCall.",
            );
          }

          // Emit tool_call_start events
          for (const tc of toolCalls) {
            yield {
              kind: "tool_call_start" as const,
              toolName: tc.toolName,
              callId: tc.callId,
              args: tc.input,
            };
          }

          const toolResults = await Promise.all(
            toolCalls.map((tc) => executeToolCall(tc, toolHandler)),
          );

          // Emit tool_call_end events
          for (const result of toolResults) {
            yield {
              kind: "tool_call_end" as const,
              callId: result.descriptor.callId,
              result: result.response.output,
            };
          }

          messages.push(buildAssistantMessage(response.content, response.metadata));
          messages.push(...buildToolResultMessages(toolResults));
          metrics = incrementTurn(metrics);
          yield { kind: "turn_end" as const, turnIndex: turn };
        }

        // If this was the last allowed turn, mark as max_turns
        if (turn === maxTurns - 1) {
          stopReason = "max_turns";
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
