/**
 * Configuration types for the memory recall middleware.
 */

import type { FileSystemBackend, ModelHandler } from "@koi/core";
import type { RecallConfig } from "@koi/memory";

/** Configuration for createMemoryRecallMiddleware. */
export interface MemoryRecallMiddlewareConfig {
  /** FileSystemBackend for reading memory files. */
  readonly fs: FileSystemBackend;
  /** Recall pipeline configuration (memoryDir, tokenBudget, salience, format). */
  readonly recall: RecallConfig;
  /**
   * Optional model call for on-demand relevance selection.
   *
   * When provided, the middleware runs a per-turn side-query: sends the
   * memory manifest (name + description of all .md files) and the user's
   * current message to this model, which picks the N most relevant files.
   * Selected files are loaded and injected alongside the frozen snapshot.
   *
   * Use a lightweight/cheap model (Haiku, Gemini Flash, local) to keep
   * latency and cost low. The side-query adds ~200-500ms per turn.
   *
   * When omitted, only the frozen snapshot (salience-scored top memories)
   * is injected — no per-turn relevance filtering.
   */
  readonly relevanceSelector?:
    | {
        /** Model call function for the selector side-query. */
        readonly modelCall: ModelHandler;
        /** Maximum relevant files to select per turn. Default: 5. */
        readonly maxFiles?: number | undefined;
      }
    | undefined;
}
