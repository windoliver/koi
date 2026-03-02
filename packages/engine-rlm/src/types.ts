/**
 * Types and configuration for @koi/engine-rlm.
 *
 * RLM (Recursive Language Models) virtualizes unbounded input outside the
 * context window and gives the model tools to programmatically examine,
 * chunk, and recursively sub-query it.
 */

import type { ModelHandler, ModelStreamHandler, ToolHandler } from "@koi/core";

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

/** Maximum chars per `examine` call to prevent accidental full-input reads. */
export const MAX_EXAMINE_LENGTH: number = 50_000;

/** Maximum prompts per `llm_query_batched` call. */
export const MAX_BATCH_PROMPTS: number = 50;

// ---------------------------------------------------------------------------
// RLM spawn request/result (for rlm_query tool)
// ---------------------------------------------------------------------------

/**
 * Request object passed to the `spawnRlmChild` callback when `rlm_query`
 * is invoked. The consumer (CLI or parent adapter) is responsible for
 * creating a child RLM adapter with these parameters.
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
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the RLM engine adapter.
 */
export interface RlmConfig {
  /** Raw model call terminal — the actual LLM call function. */
  readonly modelCall: ModelHandler;
  /** Raw model stream terminal — optional streaming LLM call. */
  readonly modelStream?: ModelStreamHandler | undefined;
  /** Raw tool call terminal — optional, falls back to callHandlers. */
  readonly toolCall?: ToolHandler | undefined;
  /** Model identifier for root-level calls. */
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
}
