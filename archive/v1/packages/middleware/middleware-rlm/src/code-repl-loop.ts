/**
 * Code-execution REPL loop — alternative to tool-dispatch repl-loop.ts.
 *
 * Instead of the model calling predefined tools, it writes JavaScript code
 * that is executed in a sandboxed environment. Host functions (readInput,
 * llm_query, SUBMIT, etc.) are injected as synchronous callTool() calls
 * from the guest's perspective.
 *
 * Selected when `config.scriptRunner` is present.
 */

import type { InboundMessage, JsonObject, ModelHandler } from "@koi/core";
import { extractCodeBlock } from "./code-parser.js";
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
import type {
  ReplLoopResult,
  RlmEvent,
  RlmMiddlewareConfig,
  RlmScriptRunner,
  RlmStopReason,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONSOLE_OUTPUT_CHARS = 10_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SCRIPT_CALLS = 100;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface CodeReplLoopDeps {
  readonly scriptRunner: RlmScriptRunner;
  readonly modelCall: ModelHandler;
  readonly input: string;
  readonly question: string;
  readonly config: RlmMiddlewareConfig;
  readonly signal?: AbortSignal | undefined;
  readonly onEvent?: ((event: RlmEvent) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Preamble (wrapper functions prepended to model's code)
// ---------------------------------------------------------------------------

const RLM_PREAMBLE = `function readInput(offset, length) {
  return callTool("readInput", { offset: offset, length: length });
}
function inputInfo() { return callTool("inputInfo", {}); }
function llm_query(prompt) { return callTool("llm_query", { prompt: prompt }); }
function llm_query_batched(prompts) { return callTool("llm_query_batched", { prompts: prompts }); }
function sharedFindings() { return callTool("sharedFindings", {}); }
function SUBMIT(answer) {
  return callTool("SUBMIT", {
    answer: typeof answer === "string" ? answer : JSON.stringify(answer)
  });
}
`;

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function generateSystemPrompt(
  question: string,
  format: string,
  sizeBytes: number,
  estimatedTokens: number,
  preview: string,
  parentContext?: string | undefined,
): string {
  return (
    `You are an RLM agent analyzing a large input via code execution.\n\n` +
    `## Question\n${question}\n\n` +
    `## Input Metadata\n` +
    `- Format: ${format}, Size: ${String(sizeBytes)} bytes (~${String(estimatedTokens)} tokens)\n` +
    `- Preview: ${preview}\n\n` +
    `## Available Functions\n` +
    `- readInput(offset, length) — read a slice of the input (max 50K chars)\n` +
    `- inputInfo() — returns { format, sizeBytes, totalChunks, preview }\n` +
    `- llm_query(prompt) — sub-LLM query for semantic analysis\n` +
    `- llm_query_batched(prompts) — parallel sub-LLM queries (array of strings)\n` +
    `- sharedFindings() — returns findings from sibling sub-calls\n` +
    `- SUBMIT(answer) — submit your final answer (string)\n\n` +
    `## Guidelines\n` +
    `1. EXPLORE FIRST — readInput(0, 2000) to understand structure\n` +
    `2. ITERATE — small code blocks, console.log() to see results\n` +
    `3. Each code block runs independently — variables do not persist between steps\n` +
    `4. Use llm_query for meaning, readInput for data access\n` +
    `5. SUBMIT when confident in your answer\n\n` +
    `Provide code in a \`\`\`javascript block.` +
    (parentContext !== undefined ? `\n\n## Parent Context\n${parentContext}` : "")
  );
}

// ---------------------------------------------------------------------------
// Console output truncation
// ---------------------------------------------------------------------------

function truncateConsoleOutput(lines: readonly string[]): string {
  const joined = lines.join("\n");
  if (joined.length <= MAX_CONSOLE_OUTPUT_CHARS) return joined;

  const half = Math.floor(MAX_CONSOLE_OUTPUT_CHARS / 2);
  return (
    joined.slice(0, half) +
    `\n\n... [truncated ${String(joined.length - MAX_CONSOLE_OUTPUT_CHARS)} chars] ...\n\n` +
    joined.slice(-half)
  );
}

// ---------------------------------------------------------------------------
// History entry builder
// ---------------------------------------------------------------------------

function formatStepHistory(turn: number, code: string, consoleOutput: string): string {
  return (
    `=== Step ${String(turn + 1)} ===\n` +
    `Code:\n\`\`\`javascript\n${code}\n\`\`\`\n` +
    `Output (${String(consoleOutput.length)} chars):\n${consoleOutput}`
  );
}

// ---------------------------------------------------------------------------
// Code REPL loop
// ---------------------------------------------------------------------------

/**
 * Run the code-execution REPL loop.
 *
 * The model writes JavaScript code blocks, which are executed in a sandbox
 * with RLM host functions. The loop repeats until SUBMIT is called,
 * maxIterations is reached, or the model returns no code block.
 */
export async function runCodeReplLoop(deps: CodeReplLoopDeps): Promise<ReplLoopResult> {
  const { scriptRunner, modelCall, input, question, config, signal } = deps;
  const resolved = resolveConfig(config);
  const {
    maxIterations,
    maxInputBytes,
    chunkSize,
    previewLength,
    compactionThreshold,
    contextWindowTokens,
    maxConcurrency,
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
  const meta = store.metadata();

  // let: set by SUBMIT host function
  let finalAnswer: string | undefined;
  const sharedLog = createSharedLog();

  // Build host functions map
  const hostFns = createHostFns(
    store,
    modelCall,
    semaphore,
    tracker,
    config,
    sharedLog,
    (answer: string) => {
      finalAnswer = answer;
    },
  );

  // Build system prompt
  const systemPrompt = generateSystemPrompt(
    question,
    meta.format,
    meta.sizeBytes,
    meta.estimatedTokens,
    meta.preview,
    resolved.parentContext,
  );

  const messages: InboundMessage[] = [
    {
      content: [{ kind: "text" as const, text: systemPrompt }],
      senderId: "user",
      timestamp: Date.now(),
      pinned: true,
    },
  ];
  tracker.add(systemPrompt);

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
      messages.length = 0;
      messages.push(...compacted);
      sharedLog.clear();
    }

    onEvent?.({ kind: "turn_start", turn });

    // Call model
    // let: response may come from try/catch
    let responseContent: string;
    try {
      const response = await modelCall({
        messages,
        ...(resolved.rootModel !== undefined ? { model: resolved.rootModel } : {}),
      });

      metrics = addModelUsage(metrics, response);
      if (costTracker !== undefined && response.usage !== undefined) {
        costTracker.add(
          resolved.rootModel ?? "unknown",
          response.usage.inputTokens,
          response.usage.outputTokens,
        );
      }
      tracker.add(response.content);
      responseContent = response.content;
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

    // Extract code block
    const codeBlock = extractCodeBlock(responseContent);

    if (codeBlock === undefined) {
      // No code block: treat as implicit final answer
      metrics = incrementTurn(metrics);
      onEvent?.({ kind: "turn_end", turn });
      const result: ReplLoopResult = {
        answer: responseContent,
        stopReason: "completed",
        metrics: finalizeMetrics(metrics, costTracker?.total()),
      };
      onEvent?.({ kind: "done", result });
      return result;
    }

    // Execute code in sandbox
    const fullCode = RLM_PREAMBLE + codeBlock.code;
    const scriptResult = await scriptRunner.run({
      code: fullCode,
      hostFns,
      timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS,
      maxCalls: DEFAULT_MAX_SCRIPT_CALLS,
    });

    onEvent?.({ kind: "code_exec", turn, ok: scriptResult.ok });

    // Build console output for history
    const consoleOutput = scriptResult.ok
      ? truncateConsoleOutput(scriptResult.console)
      : `Error: ${scriptResult.error ?? "unknown error"}\n${truncateConsoleOutput(scriptResult.console)}`;

    const stepHistory = formatStepHistory(turn, codeBlock.code, consoleOutput);
    tracker.add(stepHistory);

    messages.push(
      {
        content: [{ kind: "text" as const, text: responseContent }],
        senderId: "assistant",
        timestamp: Date.now(),
      },
      {
        content: [{ kind: "text" as const, text: stepHistory }],
        senderId: "user",
        timestamp: Date.now(),
      },
    );

    metrics = incrementTurn(metrics);
    onEvent?.({ kind: "turn_end", turn });

    // Check if SUBMIT was called during execution
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

  // Max iterations or aborted
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

// ---------------------------------------------------------------------------
// Host functions factory (extracted to keep main loop < 50 lines per section)
// ---------------------------------------------------------------------------

interface InputStoreLike {
  readonly examine: (offset: number, length: number) => string;
  readonly metadata: () => {
    readonly format: string;
    readonly sizeBytes: number;
    readonly totalChunks: number;
    readonly preview: string;
  };
}

interface SemaphoreLike {
  readonly run: <T>(fn: () => Promise<T>) => Promise<T>;
}

interface TokenTrackerLike {
  readonly add: (text: string) => void;
  readonly addTokens: (count: number) => void;
}

interface SharedLogLike {
  readonly entries: () => readonly string[];
}

function createHostFns(
  store: InputStoreLike,
  modelCall: ModelHandler,
  semaphore: SemaphoreLike,
  tracker: TokenTrackerLike,
  config: RlmMiddlewareConfig,
  sharedLog: SharedLogLike,
  onSubmit: (answer: string) => void,
): ReadonlyMap<string, (args: JsonObject) => Promise<unknown> | unknown> {
  return new Map<string, (args: JsonObject) => Promise<unknown> | unknown>([
    [
      "readInput",
      (args: JsonObject) => {
        const offset = typeof args.offset === "number" ? args.offset : 0;
        const length = typeof args.length === "number" ? args.length : 2000;
        return store.examine(offset, length);
      },
    ],
    [
      "inputInfo",
      () => {
        const meta = store.metadata();
        return {
          format: meta.format,
          sizeBytes: meta.sizeBytes,
          totalChunks: meta.totalChunks,
          preview: meta.preview,
        };
      },
    ],
    [
      "llm_query",
      async (args: JsonObject) => {
        const prompt = typeof args.prompt === "string" ? args.prompt : String(args.prompt);
        const response = await modelCall({
          messages: [
            {
              content: [{ kind: "text" as const, text: prompt }],
              senderId: "user",
              timestamp: Date.now(),
            },
          ],
          ...(config.subCallModel !== undefined ? { model: config.subCallModel } : {}),
        });
        tracker.add(prompt);
        tracker.add(response.content);
        if (response.usage !== undefined) {
          tracker.addTokens(response.usage.inputTokens + response.usage.outputTokens);
        }
        return response.content;
      },
    ],
    [
      "llm_query_batched",
      async (args: JsonObject) => {
        const rawPrompts = Array.isArray(args.prompts) ? args.prompts : [];
        if (!rawPrompts.every((p): p is string => typeof p === "string")) {
          return "Error: all prompts must be strings.";
        }
        const prompts: readonly string[] = rawPrompts;
        const settled = await Promise.allSettled(
          prompts.map((prompt) =>
            semaphore.run(async () => {
              const response = await modelCall({
                messages: [
                  {
                    content: [{ kind: "text" as const, text: String(prompt) }],
                    senderId: "user",
                    timestamp: Date.now(),
                  },
                ],
                ...(config.subCallModel !== undefined ? { model: config.subCallModel } : {}),
              });
              tracker.add(String(prompt));
              tracker.add(response.content);
              return response.content;
            }),
          ),
        );
        const outputs = settled.map((r) =>
          r.status === "fulfilled"
            ? r.value
            : `Error: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        );
        return outputs;
      },
    ],
    [
      "sharedFindings",
      () => {
        const items = sharedLog.entries();
        return items.length === 0 ? "No shared findings yet." : items.join("\n");
      },
    ],
    [
      "SUBMIT",
      (args: JsonObject) => {
        const answer = typeof args.answer === "string" ? args.answer : JSON.stringify(args.answer);
        onSubmit(answer);
        return "submitted";
      },
    ],
  ]);
}
