/**
 * Configuration types for the collective memory middleware.
 */

import type {
  CollectiveMemoryCategory,
  ForgeStore,
  ModelRequest,
  ModelResponse,
  TokenEstimator,
} from "@koi/core";

/** A candidate learning extracted from worker output. */
export interface LearningCandidate {
  readonly content: string;
  readonly category: CollectiveMemoryCategory;
  readonly confidence: number; // [0, 1]
}

/** Pluggable extractor interface for learning extraction strategies. */
export interface LearningExtractor {
  readonly extract: (output: string) => readonly LearningCandidate[];
}

/** Configuration for the collective memory middleware factory. */
export interface CollectiveMemoryMiddlewareConfig {
  readonly forgeStore: ForgeStore;
  readonly resolveBrickId: (agentName: string) => string | undefined;
  readonly tokenEstimator?: TokenEstimator | undefined;
  readonly extractor?: LearningExtractor | undefined;
  readonly maxEntries?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly coldAgeDays?: number | undefined;
  readonly injectionBudget?: number | undefined;
  readonly dedupThreshold?: number | undefined;
  readonly autoCompact?: boolean | undefined;
  /** Model call function for LLM-based extraction. If not provided, only regex extraction is used. */
  readonly modelCall?: ((request: ModelRequest) => Promise<ModelResponse>) | undefined;
  /** Model to specify in extraction requests. Default: undefined (caller decides). */
  readonly extractionModel?: string | undefined;
  /** Max tokens for extraction response. Default: 1024. */
  readonly extractionMaxTokens?: number | undefined;
}
