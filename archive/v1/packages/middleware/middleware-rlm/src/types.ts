/**
 * Types and configuration for @koi/middleware-rlm.
 *
 * RLM (Recursive Language Models) virtualizes unbounded input outside the
 * context window and gives the model tools to programmatically examine,
 * chunk, and recursively sub-query it.
 *
 * This middleware variant can be composed with any engine adapter.
 */

import type { JsonObject } from "@koi/core";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_ITERATIONS: number = 30;
export const DEFAULT_MAX_INPUT_BYTES: number = 100 * 1024 * 1024; // 100 MB
export const DEFAULT_CHUNK_SIZE: number = 4_000;
export const DEFAULT_PREVIEW_LENGTH: number = 200;
export const DEFAULT_COMPACTION_THRESHOLD: number = 0.8;
export const DEFAULT_CONTEXT_WINDOW_TOKENS: number = 100_000;
export const DEFAULT_MAX_CONCURRENCY: number = 5;
export const DEFAULT_DEPTH: number = 0;
export const DEFAULT_MAX_DEPTH: number = 3;
export const DEFAULT_PRIORITY: number = 300;
export const DEFAULT_TIME_BUDGET_MS: number = 300_000; // 5 minutes

/** Maximum chars per `examine` call to prevent accidental full-input reads. */
export const MAX_EXAMINE_LENGTH: number = 50_000;

/** Maximum prompts per `llm_query_batched` call. */
export const MAX_BATCH_PROMPTS: number = 50;

// ---------------------------------------------------------------------------
// RLM spawn request/result (for rlm_query tool)
// ---------------------------------------------------------------------------

/**
 * Request object passed to the `spawnRlmChild` callback when `rlm_query`
 * is invoked. The consumer is responsible for creating a child RLM with
 * these parameters.
 */
export interface RlmSpawnRequest {
  /** The input text for the child RLM agent to process. */
  readonly input: string;
  /** Recursion depth — incremented from the parent's depth. */
  readonly depth: number;
  /** Remaining token budget the child should respect. */
  readonly remainingTokenBudget: number;
  /** Remaining wall-clock time in milliseconds. */
  readonly remainingTimeMs: number;
  /** Parent context summary for fork mode (optional). */
  readonly parentContext?: string | undefined;
  /** Remaining cost budget in USD (optional, only when cost tracking is active). */
  readonly remainingCostUsd?: number | undefined;
}

/**
 * Result returned by a child RLM agent spawn.
 */
export interface RlmSpawnResult {
  /** The child agent's final answer. */
  readonly answer: string;
  /** Tokens consumed by the child (for budget tracking). */
  readonly tokensUsed: number;
}

// ---------------------------------------------------------------------------
// Input metadata (returned by input_info tool)
// ---------------------------------------------------------------------------

/** Detected format of the virtualized input. */
export type InputFormat = "json" | "markdown" | "csv" | "plaintext";

/**
 * Metadata about the virtualized input, returned by `input_info` tool.
 */
export interface InputMetadata {
  readonly format: InputFormat;
  readonly sizeBytes: number;
  readonly estimatedTokens: number;
  readonly totalChunks: number;
  readonly structureHints: readonly string[];
  readonly preview: string;
}

// ---------------------------------------------------------------------------
// Chunk descriptor (returned by chunk tool)
// ---------------------------------------------------------------------------

/**
 * Metadata about a single chunk — NOT the content itself.
 * Callers must use `examine` to read actual content.
 */
export interface ChunkDescriptor {
  readonly index: number;
  readonly offset: number;
  readonly length: number;
  readonly preview: string;
}

// ---------------------------------------------------------------------------
// Script runner (code-execution mode)
// ---------------------------------------------------------------------------

/**
 * Script runner interface — implemented by L3 stack (e.g., @koi/rlm-stack).
 *
 * Executes JavaScript code in a sandboxed environment with host functions
 * exposed as synchronous `callTool()` calls from guest code.
 */
export interface RlmScriptRunner {
  readonly run: (config: RlmScriptRunConfig) => Promise<RlmScriptResult>;
}

/** Configuration for a single script execution. */
export interface RlmScriptRunConfig {
  readonly code: string;
  readonly hostFns: ReadonlyMap<string, (args: JsonObject) => Promise<unknown> | unknown>;
  readonly timeoutMs?: number | undefined;
  readonly maxCalls?: number | undefined;
}

/** Result from a single script execution. */
export interface RlmScriptResult {
  readonly ok: boolean;
  readonly console: readonly string[];
  readonly result: unknown;
  readonly error?: string | undefined;
  readonly callCount: number;
}

// ---------------------------------------------------------------------------
// RLM events (for observability)
// ---------------------------------------------------------------------------

/** Stop reason for a completed REPL loop. */
export type RlmStopReason = "completed" | "max_turns" | "interrupted" | "error" | "budget_exceeded";

/** Aggregate metrics from a REPL loop run. */
export interface RlmMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly turns: number;
  readonly durationMs: number;
  /** Accumulated cost in USD (only set when costEstimator is configured). */
  readonly costUsd?: number | undefined;
}

/** Result returned by a completed REPL loop. */
export interface ReplLoopResult {
  readonly answer: string;
  readonly stopReason: RlmStopReason;
  readonly metrics: RlmMetrics;
}

/** Discriminated union of events emitted by the REPL loop. */
export type RlmEvent =
  | { readonly kind: "turn_start"; readonly turn: number }
  | { readonly kind: "turn_end"; readonly turn: number }
  | { readonly kind: "compaction"; readonly turn: number; readonly utilization: number }
  | { readonly kind: "tool_dispatch"; readonly toolName: string; readonly callId: string }
  | { readonly kind: "code_exec"; readonly turn: number; readonly ok: boolean }
  | { readonly kind: "done"; readonly result: ReplLoopResult };

// ---------------------------------------------------------------------------
// Middleware configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the RLM middleware.
 *
 * Unlike the engine-level RlmConfig, this does not include modelCall /
 * modelStream / toolCall terminals — the middleware captures the downstream
 * model handler from `wrapModelCall.next`.
 */
export interface RlmMiddlewareConfig {
  /** Middleware priority. Default: 300 (before model-router). */
  readonly priority?: number | undefined;
  /** Model identifier for root-level REPL calls. */
  readonly rootModel?: string | undefined;
  /** Model identifier for sub-calls (llm_query, compaction). */
  readonly subCallModel?: string | undefined;
  /** Maximum REPL loop iterations before forced stop. Default: 30. */
  readonly maxIterations?: number | undefined;
  /** Maximum input size in bytes. Default: 100 MB. */
  readonly maxInputBytes?: number | undefined;
  /** Characters per chunk for the `chunk` tool. Default: 4000. */
  readonly chunkSize?: number | undefined;
  /** Characters shown in metadata preview. Default: 200. */
  readonly previewLength?: number | undefined;
  /** Fraction of context window that triggers compaction. Default: 0.8. */
  readonly compactionThreshold?: number | undefined;
  /** Total context window size in tokens. Default: 100,000. */
  readonly contextWindowTokens?: number | undefined;
  /** Max concurrent calls in `llm_query_batched`. Default: 5. */
  readonly maxConcurrency?: number | undefined;
  /** Callback to spawn a child RLM agent for `rlm_query`. */
  readonly spawnRlmChild?: ((req: RlmSpawnRequest) => Promise<RlmSpawnResult>) | undefined;
  /** Current recursion depth. Default: 0. */
  readonly depth?: number | undefined;
  /** Maximum recursion depth. Default: 3. Tools are stripped at this depth. */
  readonly maxDepth?: number | undefined;
  /** Event callback for observability. */
  readonly onEvent?: ((event: RlmEvent) => void) | undefined;
  /**
   * Script runner for code-execution mode. When provided, the REPL loop
   * uses code execution (model writes JavaScript) instead of tool dispatch.
   * Typically created by @koi/rlm-stack which wires @koi/code-executor.
   */
  readonly scriptRunner?: RlmScriptRunner | undefined;
  /**
   * Maximum cost in USD. When set with costEstimator, the REPL loop halts
   * with "budget_exceeded" when cumulative cost reaches this ceiling.
   * Opt-in — no effect when undefined.
   */
  readonly maxCostUsd?: number | undefined;
  /**
   * Sync cost estimator callback. Returns cost in USD for a model call.
   * Required for maxCostUsd enforcement.
   */
  readonly costEstimator?:
    | ((modelId: string, inputTokens: number, outputTokens: number) => number)
    | undefined;
  /**
   * Parent context summary for fork mode. When set, injected into the
   * REPL system prompt so the sub-agent inherits the parent's reasoning.
   */
  readonly parentContext?: string | undefined;
}
