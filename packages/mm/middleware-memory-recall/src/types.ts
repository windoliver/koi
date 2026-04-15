/**
 * Configuration types for the memory recall middleware.
 */

import type { FileSystemBackend } from "@koi/core";
import type { RecallConfig } from "@koi/memory";

/** Configuration for createMemoryRecallMiddleware. */
export interface MemoryRecallMiddlewareConfig {
  /** FileSystemBackend for reading memory files. */
  readonly fs: FileSystemBackend;
  /** Recall pipeline configuration (memoryDir, tokenBudget, salience, format). */
  readonly recall: RecallConfig;
}
