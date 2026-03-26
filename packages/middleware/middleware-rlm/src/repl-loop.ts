/**
 * RLM REPL loop — adapted from engine-rlm adapter.ts.
 *
 * Runs the autonomous loop: inject RLM tools into a model request,
 * dispatch tool calls locally, append results to conversation history,
 * and repeat until FINAL, implicit final, or maxIterations.
 *
 * Unlike the engine adapter, this is a pure async function (not an
 * AsyncGenerator) that receives a model handler and returns a result.
 */

import type { InboundMessage, JsonObject, ModelHandler, ModelResponse } from "@koi/core";
import { compactHistory, shouldCompact } from "./compaction.js";
import { createCostTracker } from "./cost-tracker.js";
import { createInputStore } from "./input-store.js";
import {
  addModelUsage,
  createMetricsAccumulator,
  finalizeMetrics,
  incrementTurn,
} from "./metrics.js";
import { resolveConfig } from "./resolve-config.js";
import { createSemaphore } from "./semaphore.js";
import { createSharedLog } from "./shared-log.js";
import { createTokenTracker } from "./token-tracker.js";
import {
  createChunkTool,
  createExamineTool,
  createFinalTool,
  createInputInfoTool,
  createLlmQueryBatchedTool,
  createLlmQueryTool,
  createRlmQueryTool,
  createSharedContextTool,
  getAllToolDescriptors,
} from "./tools.js";
import type { ReplLoopResult, RlmEvent, RlmMiddlewareConfig, RlmStopReason } from "./types.js";

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
// Tool dispatch
// ---------------------------------------------------------------------------

interface ToolLike {
  readonly execute: (args: JsonObject) => unknown;
}

async function dispatchToolCall(
  tc: ToolCallDescriptor,
  toolMap: Readonly<Record<string, ToolLike>>,
): Promise<{ readonly output: unknown; readonly isError: boolean }> {
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

// ---------------------------------------------------------------------------
// REPL loop dependencies
// ---------------------------------------------------------------------------

export interface ReplLoopDeps {
  /** Downstream model handler (captured from wrapModelCall.next). */
  readonly modelCall: ModelHandler;
  /** The large input text to process. */
  readonly input: string;
  /** The user's question about the input. */
  readonly question: string;
  /** Middleware configuration. */
  readonly config: RlmMiddlewareConfig;
  /** Optional abort signal. */
  readonly signal?: AbortSignal | undefined;
  /** Optional event callback for observability. */
  readonly onEvent?: ((event: RlmEvent) => void) | undefined;
}

// ---------------------------------------------------------------------------
// REPL loop
// ---------------------------------------------------------------------------

/**
 * Run the RLM REPL loop.
 *
 * Creates an InputStore, injects 7 internal tools, and iterates until
 * FINAL is called, the model stops calling tools, maxIterations is
 * reached, or the signal is aborted.
 */
export async function runReplLoop(deps: ReplLoopDeps): Promise<ReplLoopResult> {
  const { modelCall, input, question, config, signal } = deps;
  const resolved = resolveConfig(config);
  const {
    maxIterations,
    maxInputBytes,
    chunkSize,
    previewLength,
    compactionThreshold,
    contextWindowTokens,
    maxConcurrency,
    depth,
  } = resolved;
  // Deps-level onEvent takes precedence over config-level (backward compat)
  const onEvent = deps.onEvent ?? resolved.onEvent;

  // Size guard
  const inputBytes = new TextEncoder().encode(input).length;
  if (inputBytes > maxInputBytes) {
    return {
      answer: `Error: input size (${String(inputBytes)} bytes) exceeds maximum (${String(maxInputBytes)} bytes).`,
      stopReason: "error",
      metrics: finalizeMetrics(createMetricsAccumulator()),
    };
  }

  const store = createInputStore(input, { maxInputBytes, chunkSize, previewLength });
  const tracker = createTokenTracker(contextWindowTokens);
  const semaphore = createSemaphore(maxConcurrency);
  const costTracker =
    resolved.costEstimator !== undefined ? createCostTracker(resolved.costEstimator) : undefined;
  const startTime = Date.now();

  // let: set by FINAL tool callback
  let finalAnswer: string | undefined;

  const onFinal = (answer: string): void => {
    finalAnswer = answer;
  };

  // Create tools — rlm_query only when recursion is available and below maxDepth
  const inputInfoTool = createInputInfoTool({ store });
  const examineTool = createExamineTool({ store });
  const chunkTool = createChunkTool({ store });
  const llmQueryTool = createLlmQueryTool({
    modelCall,
    tracker,
    model: resolved.subCallModel,
  });
  const llmQueryBatchedTool = createLlmQueryBatchedTool({
    modelCall,
    tracker,
    semaphore,
    model: resolved.subCallModel,
  });
  const finalTool = createFinalTool({ onFinal });
  const sharedLog = createSharedLog();
  const sharedContextTool = createSharedContextTool({ entries: () => sharedLog.entries() });

  // Conditionally create rlm_query — structurally removed when unavailable
  const canRecurse = resolved.spawnRlmChild !== undefined && depth < resolved.maxDepth;
  const rlmQueryTool = canRecurse
    ? createRlmQueryTool({
        spawnRlmChild: resolved.spawnRlmChild,
        tracker,
        depth,
        startTime,
        timeBudgetMs: resolved.timeBudgetMs,
      })
    : undefined;

  const toolMap: Readonly<Record<string, ToolLike>> = {
    input_info: inputInfoTool,
    examine: examineTool,
    chunk: chunkTool,
    llm_query: llmQueryTool,
    llm_query_batched: llmQueryBatchedTool,
    ...(rlmQueryTool !== undefined ? { rlm_query: rlmQueryTool } : {}),
    shared_context: sharedContextTool,
    FINAL: finalTool,
  };

  const toolDescriptors = getAllToolDescriptors({
    inputInfo: inputInfoTool,
    examine: examineTool,
    chunk: chunkTool,
    llmQuery: llmQueryTool,
    llmQueryBatched: llmQueryBatchedTool,
    rlmQuery: rlmQueryTool,
    sharedContext: sharedContextTool,
    final: finalTool,
  });

  // Build initial system context with metadata stub
  const meta = store.metadata();
  const systemContext =
    `You are an RLM (Recursive Language Model) agent processing a virtualized input.\n\n` +
    `## Question\n${question}\n\n` +
    `## Input Metadata\n` +
    `- Format: ${meta.format}\n` +
    `- Size: ${String(meta.sizeBytes)} bytes (~${String(meta.estimatedTokens)} tokens)\n` +
    `- Chunks: ${String(meta.totalChunks)} (${String(chunkSize)} chars each)\n` +
    `- Structure hints: ${meta.structureHints.length > 0 ? meta.structureHints.join(", ") : "none"}\n` +
    `- Preview: ${meta.preview}\n\n` +
    `Use the provided tools to examine the input and produce a final answer.\n` +
    `Call FINAL with your answer when done.` +
    (resolved.parentContext !== undefined
      ? `\n\n## Parent Context\n${resolved.parentContext}`
      : "");

  // Mutable message array (local to this function)
  // let: reassigned during compaction to avoid O(n²) clear-and-push
  let messages: InboundMessage[] = [
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
  let stopReason: RlmStopReason = "completed";

  for (let turn = 0; turn < maxIterations; turn++) {
    if (signal?.aborted === true) {
      stopReason = "interrupted";
      break;
    }

    // Cost budget check
    if (
      costTracker !== undefined &&
      resolved.maxCostUsd !== undefined &&
      costTracker.exceeded(resolved.maxCostUsd)
    ) {
      stopReason = "budget_exceeded";
      break;
    }

    // Compaction check
    if (shouldCompact(tracker, compactionThreshold) && messages.length > 1) {
      onEvent?.({ kind: "compaction", turn, utilization: tracker.utilization() });
      const compacted = await compactHistory(messages, modelCall, resolved.subCallModel);
      messages = [...compacted];
      sharedLog.clear();
    }

    onEvent?.({ kind: "turn_start", turn });

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
        ...(resolved.rootModel !== undefined ? { model: resolved.rootModel } : {}),
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      metrics = incrementTurn(metrics);
      onEvent?.({ kind: "turn_end", turn });
      const result: ReplLoopResult = {
        answer: `Model error: ${message}`,
        stopReason: "error",
        metrics: finalizeMetrics(metrics, costTracker?.total()),
      };
      onEvent?.({ kind: "done", result });
      return result;
    }

    metrics = addModelUsage(metrics, response);
    if (costTracker !== undefined && response.usage !== undefined) {
      costTracker.add(
        resolved.rootModel ?? "unknown",
        response.usage.inputTokens,
        response.usage.outputTokens,
      );
    }
    tracker.add(response.content);

    const toolCalls = extractToolCalls(response);

    // No tool calls: treat as implicit final answer
    if (toolCalls.length === 0) {
      metrics = incrementTurn(metrics);
      onEvent?.({ kind: "turn_end", turn });
      const result: ReplLoopResult = {
        answer: response.content,
        stopReason: "completed",
        metrics: finalizeMetrics(metrics, costTracker?.total()),
      };
      onEvent?.({ kind: "done", result });
      return result;
    }

    // Dispatch tool calls locally
    messages.push({
      content: [{ kind: "text" as const, text: response.content }],
      senderId: "assistant",
      timestamp: Date.now(),
      ...(response.metadata !== undefined ? { metadata: response.metadata } : {}),
    });

    for (const tc of toolCalls) {
      onEvent?.({ kind: "tool_dispatch", toolName: tc.toolName, callId: tc.callId });

      const result = await dispatchToolCall(tc, toolMap);

      const outputStr =
        typeof result.output === "string" ? result.output : JSON.stringify(result.output);

      tracker.add(outputStr);
      messages.push({
        content: [{ kind: "text" as const, text: outputStr }],
        senderId: "tool",
        timestamp: Date.now(),
        metadata: { toolName: tc.toolName, callId: tc.callId },
      });
    }

    metrics = incrementTurn(metrics);
    onEvent?.({ kind: "turn_end", turn });

    // Check if FINAL was called during this round
    if (finalAnswer !== undefined) {
      const result: ReplLoopResult = {
        answer: finalAnswer,
        stopReason: "completed",
        metrics: finalizeMetrics(metrics, costTracker?.total()),
      };
      onEvent?.({ kind: "done", result });
      return result;
    }

    if (turn === maxIterations - 1) {
      stopReason = "max_turns";
    }
  }

  // Max iterations reached or aborted
  const lastMessage = messages[messages.length - 1];
  const fallbackAnswer =
    lastMessage !== undefined
      ? lastMessage.content.map((b) => (b.kind === "text" ? b.text : "")).join("")
      : "";

  const result: ReplLoopResult = {
    answer: fallbackAnswer,
    stopReason,
    metrics: finalizeMetrics(metrics, costTracker?.total()),
  };
  onEvent?.({ kind: "done", result });
  return result;
}
