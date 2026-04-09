/**
 * Types for the extraction middleware.
 *
 * Extracted learnings flow through MemoryComponent.store() from @koi/core ECS,
 * preserving fine-grained CollectiveMemoryCategory as MemoryStoreOptions.category
 * alongside the coarse MemoryType used for storage.
 */

import type {
  CollectiveMemoryCategory,
  MemoryComponent,
  MemoryType,
  ModelHandler,
} from "@koi/core";

/** A candidate learning extracted from tool output. */
export interface ExtractionCandidate {
  readonly content: string;
  readonly memoryType: MemoryType;
  readonly category: CollectiveMemoryCategory;
  readonly confidence: number; // [0, 1]
}

/** Pluggable extractor interface for learning extraction strategies. */
export interface LearningExtractor {
  readonly extract: (output: string) => readonly ExtractionCandidate[];
}

/** Configuration for the extraction middleware factory. */
export interface ExtractionMiddlewareConfig {
  /** Memory component for storing extracted learnings. */
  readonly memory: MemoryComponent;
  /** Model call function for LLM-based extraction. If omitted, only regex extraction runs. */
  readonly modelCall?: ModelHandler | undefined;
  /** Hot-memory middleware instance — called after writes to invalidate cache. */
  readonly hotMemory?: HotMemoryNotifier | undefined;
  /** Model to specify in extraction requests. */
  readonly extractionModel?: string | undefined;
  /** Max tokens for extraction response. Default: 1024. */
  readonly extractionMaxTokens?: number | undefined;
  /** Override the default regex extractor. */
  readonly extractor?: LearningExtractor | undefined;
  /** Max tool outputs to accumulate per session for LLM extraction. Default: 20. */
  readonly maxSessionOutputs?: number | undefined;
  /** Max bytes per tool output before truncation for LLM pass. Default: 10_000. */
  readonly maxOutputSizeBytes?: number | undefined;
  /**
   * Tool IDs whose outputs should trigger extraction.
   * Default: ["Spawn", "agent_spawn", "task_delegate"] — the runtime's spawn-family tools.
   */
  readonly spawnToolIds?: readonly string[] | undefined;
}

/** Minimal interface for hot-memory cache invalidation. */
export interface HotMemoryNotifier {
  readonly notifyStoreOccurred: () => void;
}

/** Defaults for extraction middleware configuration. */
export const EXTRACTION_DEFAULTS = {
  maxSessionOutputs: 20,
  maxOutputSizeBytes: 10_000,
  extractionMaxTokens: 1024,
} as const;
