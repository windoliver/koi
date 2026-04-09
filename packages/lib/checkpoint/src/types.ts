/**
 * Public types for `@koi/checkpoint`.
 *
 * `CheckpointPayload` is the snapshot payload type stored in the underlying
 * `SnapshotChainStore<CheckpointPayload>`. It is checkpoint-specific (not the
 * L0 `AgentSnapshot`) because the checkpoint middleware does not have access
 * to engine internals like `engineState`, `processState`, or `components` —
 * those would have to come through `TurnContext`, which they currently don't.
 *
 * Keeping a smaller, focused payload also matches the spec: a checkpoint is
 * "the file ops the agent performed during this turn + drift warnings + a
 * pointer back to the conversation log offset for the conversation half of
 * the rewind." That's all this type carries.
 */

import type { FileOpRecord } from "@koi/core";

/**
 * The payload stored in the snapshot chain for each captured turn.
 *
 * One `CheckpointPayload` per turn boundary. Multiple `FileOpRecord` entries
 * per payload — one per `wrapToolCall` invocation that touched a tracked file.
 */
export interface CheckpointPayload {
  /** Monotonic turn index within the session, copied from `TurnContext.turnIndex`. */
  readonly turnIndex: number;
  /** Session this checkpoint belongs to. */
  readonly sessionId: string;
  /** File operations captured during this turn (tracked tools only). */
  readonly fileOps: readonly FileOpRecord[];
  /**
   * Drift warnings from `git status --porcelain` at end of turn — paths
   * touched outside the tracked tool pipeline. Surfaced on rewind, never
   * restored. Empty array means no drift detected (or drift detection
   * disabled in config).
   */
  readonly driftWarnings: readonly string[];
  /** Unix ms when the checkpoint was created. */
  readonly capturedAt: number;
}

/**
 * Configuration for `createCheckpointMiddleware`.
 */
export interface CheckpointMiddlewareConfig {
  /**
   * Path to the content-addressed blob directory. The middleware writes
   * pre-image and post-image file content here, keyed by SHA-256 hash.
   * Layout: `<blobDir>/<first-2-hex>/<full-sha256-hex>`.
   */
  readonly blobDir: string;

  /**
   * Tool IDs to intercept for file operation capture. Defaults to
   * `["fs_edit", "fs_write"]` — the v2 builtin file-modifying tools.
   *
   * Add other tool IDs (e.g., custom backends with different prefixes,
   * or `fs_multi_edit` once it exists) as needed.
   */
  readonly trackedToolIds?: readonly string[];

  /**
   * Optional drift detector. If provided, the middleware calls it during
   * the deferred phase of `onAfterTurn` to gather drift warnings.
   *
   * Defaulted by the factory to a `git status --porcelain` runner over
   * `process.cwd()`. Pass `null` to disable drift detection entirely
   * (useful for tests or environments without git).
   */
  readonly driftDetector?: DriftDetector | null;
}

/**
 * Pluggable drift detector. Returns the list of drift warnings — typically
 * one entry per file path that was modified outside the tracked tool
 * pipeline (`M src/foo.ts`, `?? generated/output.json`, etc.).
 *
 * Implementations should be best-effort: any failure should return an empty
 * array rather than throw, since drift detection is advisory only.
 */
export interface DriftDetector {
  readonly detect: () => Promise<readonly string[]>;
}
