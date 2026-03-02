/**
 * RLM engine adapter — Recursive Language Model REPL loop.
 *
 * Virtualizes unbounded input outside the context window and gives the model
 * tools to programmatically examine, chunk, and recursively sub-query it.
 *
 * Cooperating adapter: exposes `terminals` for L1 middleware chain integration.
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
  ModelResponse,
} from "@koi/core";
import { toolCallId } from "@koi/core";
import { compactHistory, shouldCompact } from "./compaction.js";
import { createInputStore } from "./input-store.js";
import { createSemaphore } from "./semaphore.js";
import { createTokenTracker } from "./token-tracker.js";
import {
  createChunkTool,
  createExamineTool,
  createFinalTool,
  createInputInfoTool,
  createLlmQueryBatchedTool,
  createLlmQueryTool,
  createRlmQueryTool,
  getAllToolDescriptors,
} from "./tools.js";
import type { RlmConfig } from "./types.js";
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_DEPTH,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PREVIEW_LENGTH,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENGINE_ID = "koi-rlm" as const;
const DEFAULT_TIME_BUDGET_MS = 300_000 as const; // 5 minutes

// ---------------------------------------------------------------------------
// Tool call metadata shape (same as engine-loop)
// ---------------------------------------------------------------------------

interface ToolCallDescriptor {
  readonly toolName: string;
  readonly callId: string;
  readonly input: JsonObject;
}

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

function extractToolCalls(response: ModelResponse): readonly ToolCallDescriptor[] {
  if (response.metadata === undefined) return [];
  const toolCalls: unknown = response.metadata.toolCalls;
  if (toolCalls === undefined) return [];
  if (!isToolCallArray(toolCalls)) return [];
  return toolCalls;
}

// ---------------------------------------------------------------------------
// Input extraction
// ---------------------------------------------------------------------------

function extractTextFromInput(input: EngineInput): string {
  switch (input.kind) {
    case "text":
      return input.text;
    case "messages": {
      return input.messages
        .map((m) => m.content.map((b) => (b.kind === "text" ? b.text : "")).join(""))
        .join("\n");
    }
    case "resume":
      return "";
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface MetricsAccumulator {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turns: number;
  readonly startTime: number;
}

function createMetricsAccumulator(): MetricsAccumulator {
  return { inputTokens: 0, outputTokens: 0, turns: 0, startTime: Date.now() };
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
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an RLM engine adapter.
 *
 * The adapter runs a REPL loop: inject RLM tools into the model request,
 * dispatch tool calls locally, append results to the conversation, and repeat
 * until FINAL is called, the model stops calling tools, or maxIterations
 * is reached.
 */
export function createRlmAdapter(config: RlmConfig): EngineAdapter {
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxInputBytes = config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const previewLength = config.previewLength ?? DEFAULT_PREVIEW_LENGTH;
  const compactionThreshold = config.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const contextWindowTokens = config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const depth = config.depth ?? DEFAULT_DEPTH;

  // let: toggled once by dispose()
  let disposed = false;
  // let: guards against concurrent runs
  let running = false;
  // let: saved state for persistence
  let savedMessages: readonly InboundMessage[] = [];

  function resolveModelCall(callHandlers: ComposedCallHandlers | undefined): ModelHandler {
    if (callHandlers !== undefined) return callHandlers.modelCall;
    return config.modelCall;
  }

  async function* runLoop(input: EngineInput): AsyncGenerator<EngineEvent, void, undefined> {
    if (running) {
      throw new Error(
        "RlmAdapter does not support concurrent runs. Wait for the current run to complete.",
      );
    }
    running = true;

    try {
      // Extract the input text to virtualize
      const inputText = extractTextFromInput(input);

      // Size guard
      const inputBytes = new TextEncoder().encode(inputText).length;
      if (inputBytes > maxInputBytes) {
        const output: EngineOutput = {
          content: [
            {
              kind: "text" as const,
              text: `Error: input size (${String(inputBytes)} bytes) exceeds maximum (${String(maxInputBytes)} bytes).`,
            },
          ],
          stopReason: "error",
          metrics: finalizeMetrics(createMetricsAccumulator()),
        };
        yield { kind: "done" as const, output };
        return;
      }

      const callHandlers = input.callHandlers;
      const modelCall = resolveModelCall(callHandlers);
      const store = createInputStore(inputText, { maxInputBytes, chunkSize, previewLength });
      const tracker = createTokenTracker(contextWindowTokens);
      const semaphore = createSemaphore(maxConcurrency);
      const startTime = Date.now();

      // let: set by FINAL tool callback
      let finalAnswer: string | undefined;

      const onFinal = (answer: string): void => {
        finalAnswer = answer;
      };

      // Create all 7 tools
      const inputInfoTool = createInputInfoTool({ store });
      const examineTool = createExamineTool({ store });
      const chunkTool = createChunkTool({ store });
      const llmQueryTool = createLlmQueryTool({
        modelCall,
        tracker,
        model: config.subCallModel,
      });
      const llmQueryBatchedTool = createLlmQueryBatchedTool({
        modelCall,
        tracker,
        semaphore,
        model: config.subCallModel,
      });
      const rlmQueryTool = createRlmQueryTool({
        spawnRlmChild: config.spawnRlmChild,
        tracker,
        depth,
        startTime,
        timeBudgetMs: DEFAULT_TIME_BUDGET_MS,
      });
      const finalTool = createFinalTool({ onFinal });

      const toolDescriptors = getAllToolDescriptors({
        inputInfo: inputInfoTool,
        examine: examineTool,
        chunk: chunkTool,
        llmQuery: llmQueryTool,
        llmQueryBatched: llmQueryBatchedTool,
        rlmQuery: rlmQueryTool,
        final: finalTool,
      });

      // Build initial system context with metadata stub
      const meta = store.metadata();
      const systemContext =
        `You are an RLM (Recursive Language Model) agent processing a virtualized input.\n\n` +
        `## Input Metadata\n` +
        `- Format: ${meta.format}\n` +
        `- Size: ${String(meta.sizeBytes)} bytes (~${String(meta.estimatedTokens)} tokens)\n` +
        `- Chunks: ${String(meta.totalChunks)} (${String(chunkSize)} chars each)\n` +
        `- Structure hints: ${meta.structureHints.length > 0 ? meta.structureHints.join(", ") : "none"}\n` +
        `- Preview: ${meta.preview}\n\n` +
        `Use the provided tools to examine the input and produce a final answer.\n` +
        `Call FINAL with your answer when done.`;

      // Mutable message array (local to this generator)
      const messages: InboundMessage[] = [
        {
          content: [{ kind: "text" as const, text: systemContext }],
          senderId: "user",
          timestamp: Date.now(),
          pinned: true,
        },
      ];

      tracker.add(systemContext);

      // let: accumulated immutably via reassignment
      let metrics = createMetricsAccumulator();
      let stopReason: EngineStopReason = "completed";

      for (let turn = 0; turn < maxIterations; turn++) {
        if (disposed) {
          stopReason = "interrupted";
          break;
        }

        // Compaction check
        if (shouldCompact(tracker, compactionThreshold) && messages.length > 1) {
          yield {
            kind: "custom" as const,
            type: "rlm:compaction",
            data: { turn, utilization: tracker.utilization() },
          };
          const compacted = await compactHistory(messages, modelCall, config.subCallModel);
          // Replace messages array content
          messages.length = 0;
          messages.push(...compacted);
        }

        yield { kind: "turn_start" as const, turnIndex: turn };

        // Model call with RLM tools injected
        // let: response may come from try/catch
        let response: ModelResponse;
        try {
          response = await modelCall({
            messages,
            tools: toolDescriptors.map((d) => ({
              name: d.name,
              description: d.description,
              inputSchema: d.inputSchema,
            })),
            ...(config.rootModel !== undefined ? { model: config.rootModel } : {}),
          });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          stopReason = "error";
          metrics = incrementTurn(metrics);
          const output: EngineOutput = {
            content: [{ kind: "text" as const, text: `Model error: ${message}` }],
            stopReason,
            metrics: finalizeMetrics(metrics),
          };
          yield { kind: "turn_end" as const, turnIndex: turn };
          yield { kind: "done" as const, output };
          return;
        }

        metrics = addModelUsage(metrics, response);
        tracker.add(response.content);

        const toolCalls = extractToolCalls(response);

        // No tool calls: treat as implicit final answer
        if (toolCalls.length === 0) {
          if (response.content.length > 0) {
            yield { kind: "text_delta" as const, delta: response.content };
          }
          messages.push({
            content: [{ kind: "text" as const, text: response.content }],
            senderId: "assistant",
            timestamp: Date.now(),
          });
          metrics = incrementTurn(metrics);
          yield { kind: "turn_end" as const, turnIndex: turn };

          const output: EngineOutput = {
            content: [{ kind: "text" as const, text: response.content }],
            stopReason: "completed",
            metrics: finalizeMetrics(metrics),
          };
          savedMessages = [...messages];
          yield { kind: "done" as const, output };
          return;
        }

        // Dispatch tool calls locally
        messages.push({
          content: [{ kind: "text" as const, text: response.content }],
          senderId: "assistant",
          timestamp: Date.now(),
          ...(response.metadata !== undefined ? { metadata: response.metadata } : {}),
        });

        for (const tc of toolCalls) {
          yield {
            kind: "tool_call_start" as const,
            toolName: tc.toolName,
            callId: toolCallId(tc.callId),
            args: tc.input,
          };

          const result = await dispatchToolCall(
            tc,
            inputInfoTool,
            examineTool,
            chunkTool,
            llmQueryTool,
            llmQueryBatchedTool,
            rlmQueryTool,
            finalTool,
          );

          const outputStr =
            typeof result.output === "string" ? result.output : JSON.stringify(result.output);

          yield {
            kind: "tool_call_end" as const,
            callId: toolCallId(tc.callId),
            result: result.output,
          };

          tracker.add(outputStr);
          messages.push({
            content: [{ kind: "text" as const, text: outputStr }],
            senderId: "tool",
            timestamp: Date.now(),
            metadata: { toolName: tc.toolName, callId: tc.callId },
          });
        }

        metrics = incrementTurn(metrics);
        yield { kind: "turn_end" as const, turnIndex: turn };

        // Check if FINAL was called during this round
        if (finalAnswer !== undefined) {
          const output: EngineOutput = {
            content: [{ kind: "text" as const, text: finalAnswer }],
            stopReason: "completed",
            metrics: finalizeMetrics(metrics),
          };
          savedMessages = [...messages];
          yield { kind: "done" as const, output };
          return;
        }

        if (turn === maxIterations - 1) {
          stopReason = "max_turns";
        }
      }

      // Max iterations reached or disposed
      const lastMessage = messages[messages.length - 1];
      const fallbackContent: readonly ContentBlock[] =
        lastMessage !== undefined ? lastMessage.content : [];

      const output: EngineOutput = {
        content: fallbackContent,
        stopReason,
        metrics: finalizeMetrics(metrics),
      };
      savedMessages = [...messages];
      yield { kind: "done" as const, output };
    } finally {
      running = false;
    }
  }

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
      if (
        typeof state.data === "object" &&
        state.data !== null &&
        "messages" in state.data &&
        Array.isArray((state.data as Record<string, unknown>).messages)
      ) {
        savedMessages = (state.data as Record<string, unknown>)
          .messages as readonly InboundMessage[];
      }
    },

    dispose: async (): Promise<void> => {
      disposed = true;
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

interface ToolLike {
  readonly execute: (args: JsonObject) => unknown;
}

async function dispatchToolCall(
  tc: ToolCallDescriptor,
  inputInfo: ToolLike,
  examine: ToolLike,
  chunk: ToolLike,
  llmQuery: ToolLike,
  llmQueryBatched: ToolLike,
  rlmQuery: ToolLike,
  final: ToolLike,
): Promise<{ readonly output: unknown; readonly isError: boolean }> {
  const toolMap: Record<string, ToolLike> = {
    input_info: inputInfo,
    examine,
    chunk,
    llm_query: llmQuery,
    llm_query_batched: llmQueryBatched,
    rlm_query: rlmQuery,
    FINAL: final,
  };

  const tool = toolMap[tc.toolName];
  if (tool === undefined) {
    return { output: `Error: unknown tool "${tc.toolName}".`, isError: true };
  }

  try {
    const result = await tool.execute(tc.input);
    // Tools return { output, isError } — unwrap if so
    if (
      typeof result === "object" &&
      result !== null &&
      "output" in result &&
      "isError" in result
    ) {
      return result as { readonly output: unknown; readonly isError: boolean };
    }
    return { output: result, isError: false };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { output: `Error: tool execution failed — ${message}`, isError: true };
  }
}
