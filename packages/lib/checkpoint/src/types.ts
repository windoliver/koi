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

import type { FileOpRecord, KoiError, KoiMiddleware, NodeId, SessionId } from "@koi/core";

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

/**
 * Result of a programmatic rewind operation. Discriminated by `ok` to match
 * the L0 `Result<T, E>` shape, but local to checkpoint so the success branch
 * can carry rewind-specific metadata (target node, ops applied, etc.).
 */
export type RewindResult =
  | {
      readonly ok: true;
      /** Node the chain head now points at (the new "rewind marker" snapshot). */
      readonly newHeadNodeId: NodeId;
      /** The target snapshot the rewind landed on. */
      readonly targetNodeId: NodeId;
      /** Number of file operations the restore applied to the filesystem. */
      readonly opsApplied: number;
      /** Number of snapshot turns rewound past (length of the path from old head to target). */
      readonly turnsRewound: number;
    }
  | { readonly ok: false; readonly error: KoiError };

/**
 * The `Checkpoint` interface returned by `createCheckpoint`. Combines the
 * `KoiMiddleware` (registered with `createKoi` like any other middleware)
 * with the programmatic `rewind` API.
 *
 * Capture and rewind share state via closure inside the factory — do not
 * try to instantiate the middleware separately from the rewind methods.
 */
export interface Checkpoint {
  /**
   * The middleware to register with `createKoi`. Hooks `wrapToolCall` to
   * capture pre/post images of tracked tool calls and `onAfterTurn` to
   * commit the per-turn snapshot to the chain.
   */
  readonly middleware: KoiMiddleware;
  /**
   * Rewind a session by `n` turns. Walks `n` snapshots back through the
   * chain, computes compensating file ops, applies them, and writes a new
   * "rewind marker" snapshot whose parent is the target.
   *
   * If a tool call is currently running for the session, the rewind is
   * queued and fires when the engine returns to idle. Multiple concurrent
   * rewind requests serialize per session.
   *
   * Returns `{ok: false}` if `n` exceeds the chain length, the chain is
   * empty, or any restore step fails. The restore is idempotent — re-running
   * a failed restore converges on the target state.
   */
  readonly rewind: (sessionId: SessionId, n: number) => Promise<RewindResult>;
  /**
   * Rewind a session to a specific snapshot node. Same semantics as
   * `rewind(n)` but with an explicit target.
   */
  readonly rewindTo: (sessionId: SessionId, targetNodeId: NodeId) => Promise<RewindResult>;
  /**
   * Get the current head node ID for a session, or `undefined` if no
   * snapshots have been captured yet. Useful for the rewind UI to display
   * "you are at snapshot X of N."
   */
  readonly currentHead: (sessionId: SessionId) => Promise<NodeId | undefined>;
}
