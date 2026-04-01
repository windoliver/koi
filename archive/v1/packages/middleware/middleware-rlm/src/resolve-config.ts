/**
 * Config resolution — applies defaults to RlmMiddlewareConfig.
 *
 * Extracted to eliminate duplicated `config.X ?? DEFAULT_X` blocks
 * across repl-loop.ts and code-repl-loop.ts.
 */

import type { CostEstimator } from "./cost-tracker.js";
import type {
  RlmMiddlewareConfig,
  RlmScriptRunner,
  RlmSpawnRequest,
  RlmSpawnResult,
} from "./types.js";
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_DEPTH,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PREVIEW_LENGTH,
  DEFAULT_TIME_BUDGET_MS,
} from "./types.js";

// ---------------------------------------------------------------------------
// Resolved config — all fields non-optional where defaults exist
// ---------------------------------------------------------------------------

export interface ResolvedRlmConfig {
  readonly maxIterations: number;
  readonly maxInputBytes: number;
  readonly chunkSize: number;
  readonly previewLength: number;
  readonly compactionThreshold: number;
  readonly contextWindowTokens: number;
  readonly maxConcurrency: number;
  readonly depth: number;
  readonly maxDepth: number;
  readonly timeBudgetMs: number;
  readonly rootModel: string | undefined;
  readonly subCallModel: string | undefined;
  readonly spawnRlmChild: ((req: RlmSpawnRequest) => Promise<RlmSpawnResult>) | undefined;
  readonly onEvent: RlmMiddlewareConfig["onEvent"];
  readonly scriptRunner: RlmScriptRunner | undefined;
  readonly maxCostUsd: number | undefined;
  readonly costEstimator: CostEstimator | undefined;
  readonly parentContext: string | undefined;
}

/**
 * Resolve an RlmMiddlewareConfig by applying defaults to all optional fields.
 *
 * Returns a fully-resolved config object — no downstream `?? DEFAULT` needed.
 */
export function resolveConfig(config: RlmMiddlewareConfig): ResolvedRlmConfig {
  return {
    maxIterations: config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    maxInputBytes: config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
    chunkSize: config.chunkSize ?? DEFAULT_CHUNK_SIZE,
    previewLength: config.previewLength ?? DEFAULT_PREVIEW_LENGTH,
    compactionThreshold: config.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
    contextWindowTokens: config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    maxConcurrency: config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    depth: config.depth ?? DEFAULT_DEPTH,
    maxDepth: config.maxDepth ?? DEFAULT_MAX_DEPTH,
    timeBudgetMs: DEFAULT_TIME_BUDGET_MS,
    rootModel: config.rootModel,
    subCallModel: config.subCallModel,
    spawnRlmChild: config.spawnRlmChild,
    onEvent: config.onEvent,
    scriptRunner: config.scriptRunner,
    maxCostUsd: config.maxCostUsd,
    costEstimator: config.costEstimator,
    parentContext: config.parentContext,
  };
}
