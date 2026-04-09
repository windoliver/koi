/**
 * Types for dream consolidation.
 *
 * Dream is a standalone async operation that merges similar memories,
 * prunes cold ones, and upgrades high-value ones. Designed to be called
 * by a scheduler/daemon when those exist.
 */

import type { MemoryRecord, MemoryRecordId, MemoryRecordInput, ModelHandler } from "@koi/core";

/** Similarity function — returns [0, 1] where 1 = identical. */
export type SimilarityFn = (a: string, b: string) => number;

/** Configuration for dream consolidation. */
export interface DreamConfig {
  /** Lists all memory records. */
  readonly listMemories: () => Promise<readonly MemoryRecord[]>;
  /** Writes a new memory record. */
  readonly writeMemory: (input: MemoryRecordInput) => Promise<void>;
  /** Deletes a memory record by ID. */
  readonly deleteMemory: (id: MemoryRecordId) => Promise<void>;
  /** Model call for LLM-based merge prompts. */
  readonly modelCall: ModelHandler;
  /** Override similarity function. Default: inline word-level Jaccard. */
  readonly similarity?: SimilarityFn | undefined;
  /** Model to use for consolidation. */
  readonly consolidationModel?: string | undefined;
  /** Max tokens for consolidation response. Default: 2048. */
  readonly maxConsolidationTokens?: number | undefined;
  /** Min sessions since last dream before triggering. Default: 5. */
  readonly minSessionsSinceLastDream?: number | undefined;
  /** Min time (ms) since last dream before triggering. Default: 86400000 (24h). */
  readonly minTimeSinceLastDreamMs?: number | undefined;
  /** Jaccard similarity threshold for grouping. Default: 0.5. */
  readonly mergeThreshold?: number | undefined;
  /** Salience below this threshold = prune candidate. Default: 0.05. */
  readonly pruneThreshold?: number | undefined;
  /** Directory for cross-process lock file. */
  readonly lockDir?: string | undefined;
  /** Injectable current time for testing. */
  readonly now?: number | undefined;
}

/** State used by the dream gate to decide whether to trigger. */
export interface DreamGateState {
  /** Epoch ms of last dream consolidation. 0 if never dreamed. */
  readonly lastDreamAt: number;
  /** Number of sessions that touched memory since last dream. */
  readonly sessionsSinceDream: number;
}

/** Result of a dream consolidation run. */
export interface DreamResult {
  /** Number of memory clusters merged into single records. */
  readonly merged: number;
  /** Number of cold memories pruned (deleted). */
  readonly pruned: number;
  /** Number of memories left unchanged. */
  readonly unchanged: number;
  /** Total duration in milliseconds. */
  readonly durationMs: number;
}

/** Defaults for dream configuration. */
export const DREAM_DEFAULTS = {
  maxConsolidationTokens: 2048,
  minSessionsSinceLastDream: 5,
  minTimeSinceLastDreamMs: 86_400_000, // 24h
  mergeThreshold: 0.5,
  pruneThreshold: 0.05,
} as const;
