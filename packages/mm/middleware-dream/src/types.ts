/**
 * Types for the dream consolidation middleware.
 */

import type { MemoryRecord, MemoryRecordId, MemoryRecordInput, ModelHandler } from "@koi/core";
import type { DreamResult } from "@koi/dream";

export type { DreamResult, MemoryRecord, MemoryRecordId, MemoryRecordInput };

/** Configuration for the dream middleware. */
export interface DreamMiddlewareConfig {
  /** Path to the memory directory. Gate state and lock file are stored here. */
  readonly memoryDir: string;
  /** Lists all memory records. */
  readonly listMemories: () => Promise<readonly MemoryRecord[]>;
  /** Writes a new memory record. */
  readonly writeMemory: (input: MemoryRecordInput) => Promise<void>;
  /** Deletes a memory record by ID. */
  readonly deleteMemory: (id: MemoryRecordId) => Promise<void>;
  /** Model call for LLM-based consolidation prompts. */
  readonly modelCall: ModelHandler;
  /** Override the model used for consolidation. */
  readonly consolidationModel?: string | undefined;
  /** Jaccard similarity threshold for grouping. Default: 0.5. */
  readonly mergeThreshold?: number | undefined;
  /** Salience below this threshold = prune candidate. Default: 0.05. */
  readonly pruneThreshold?: number | undefined;
  /** Min sessions since last dream before triggering. Default: 5. */
  readonly minSessionsSinceLastDream?: number | undefined;
  /** Min time (ms) since last dream before triggering. Default: 86400000 (24h). */
  readonly minTimeSinceLastDreamMs?: number | undefined;
  /** Called when consolidation completes successfully. For observability only. */
  readonly onDreamComplete?: ((result: DreamResult) => void) | undefined;
  /** Called when consolidation fails. For observability only. */
  readonly onDreamError?: ((error: unknown) => void) | undefined;
}
