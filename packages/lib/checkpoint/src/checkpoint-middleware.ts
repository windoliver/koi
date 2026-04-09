/**
 * `createCheckpointMiddleware` — thin wrapper that returns just the
 * `KoiMiddleware` half of `createCheckpoint`.
 *
 * Kept for callers that only need the middleware and not the programmatic
 * `rewind`/`rewindTo` API. New code should use `createCheckpoint` directly
 * — see `checkpoint.ts`.
 */

import type { KoiMiddleware, SnapshotChainStore } from "@koi/core";
import { createCheckpoint } from "./checkpoint.js";
import type { CheckpointMiddlewareConfig, CheckpointPayload } from "./types.js";

export interface CreateCheckpointMiddlewareInput {
  /**
   * Chain store implementing the L0 `SnapshotChainStore<CheckpointPayload>`
   * interface. The middleware doesn't import any concrete implementation —
   * the runtime injects one (typically `@koi/snapshot-store-sqlite`).
   */
  readonly store: SnapshotChainStore<CheckpointPayload>;
  /** Configuration: blob dir, tracked tool IDs, drift detector. */
  readonly config: CheckpointMiddlewareConfig;
}

/**
 * Create just the checkpoint middleware. For callers that don't need the
 * programmatic rewind API. Equivalent to `createCheckpoint(input).middleware`.
 */
export function createCheckpointMiddleware(input: CreateCheckpointMiddlewareInput): KoiMiddleware {
  return createCheckpoint(input).middleware;
}
