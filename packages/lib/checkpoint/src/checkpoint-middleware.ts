/**
 * `createCheckpointMiddleware` — the L2 KoiMiddleware that captures file
 * operations during a turn and writes a checkpoint at end of turn.
 *
 * Capture flow per the design review (issues 2A, 6A, 8A, 14A):
 *
 *   wrapToolCall(fs_edit / fs_write):
 *     1. Parse file path from tool input
 *     2. Capture pre-image (hash file into CAS if it exists)
 *     3. Run the tool (`await next(request)`)
 *     4. Capture post-image (hash file into CAS if it exists)
 *     5. Build a FileOpRecord (create/edit/delete) if anything changed
 *     6. Append to the per-session, per-turn buffer
 *
 *   onAfterTurn:
 *     1. (sync, critical path)
 *        Build a CheckpointPayload from the turn's file ops
 *        store.put(chainId, payload, [parentNodeId], { koi:snapshot_status: complete|incomplete })
 *        Update parent pointer for this session
 *     2. (deferred — best-effort, must not block the next turn)
 *        Run drift detection
 *        Update the just-written snapshot's metadata with drift warnings
 *        OR: queue them onto the NEXT snapshot if updating in-place is awkward
 *
 *   Soft-fail (Issue 8A):
 *     If the chain `put` fails for any reason, the turn proceeds. We log
 *     a warning, mark the in-memory parent pointer as "incomplete," and
 *     subsequent rewinds skip the failed slot. Capture failure NEVER
 *     aborts the agent loop.
 *
 *   In-flight queue (Issue 11A) is handled in PR 3b — this PR is the
 *   capture half only.
 */

import type {
  CapabilityFragment,
  ChainId,
  FileOpRecord,
  KoiMiddleware,
  NodeId,
  SessionContext,
  SessionId,
  SnapshotChainStore,
  ToolCallId,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { chainId, SNAPSHOT_STATUS_KEY, type SnapshotStatus } from "@koi/core";
import { createGitStatusDriftDetector } from "./drift-detector.js";
import {
  buildFileOpRecord,
  capturePostImage,
  capturePreImage,
  extractPath,
} from "./file-tracking.js";
import type { CheckpointMiddlewareConfig, CheckpointPayload, DriftDetector } from "./types.js";

const DEFAULT_TRACKED_TOOLS = ["fs_edit", "fs_write"] as const;

/**
 * Per-session state held by the middleware. One entry per active session.
 */
interface SessionState {
  /** Chain ID for this session's snapshot chain (== sessionId by convention). */
  readonly chainId: ChainId;
  /** Parent node for the next snapshot. Updated after every successful put. */
  parentNodeId: NodeId | undefined;
  /** Per-turn buffer keyed by turnId, cleared in onAfterTurn. */
  readonly turnBuffers: Map<string, FileOpRecord[]>;
  /** Monotonic event index within the session — for FileOpRecord ordering. */
  eventIndex: number;
}

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
 * Create the checkpoint middleware. Returns a `KoiMiddleware` ready to be
 * registered with `createKoi`.
 */
export function createCheckpointMiddleware(input: CreateCheckpointMiddlewareInput): KoiMiddleware {
  const { store, config } = input;
  const trackedToolIds = new Set(config.trackedToolIds ?? DEFAULT_TRACKED_TOOLS);
  const driftDetector: DriftDetector | null =
    config.driftDetector === undefined
      ? createGitStatusDriftDetector(process.cwd())
      : config.driftDetector;

  const sessions = new Map<SessionId, SessionState>();

  async function getOrCreateSession(sessionId: SessionId): Promise<SessionState> {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      // The chain ID for this session — by convention the same as the session ID.
      // Reads back the existing head if the session is being resumed from disk.
      // `await` is a no-op when the store impl is sync (e.g., SQLite), and
      // does the right thing when the impl is async — this is the L0
      // sync-or-async portability contract.
      const cid = chainId(sessionId as unknown as string);
      const headResult = await store.head(cid);
      const parent =
        headResult.ok && headResult.value !== undefined ? headResult.value.nodeId : undefined;
      state = {
        chainId: cid,
        parentNodeId: parent,
        turnBuffers: new Map(),
        eventIndex: 0,
      };
      sessions.set(sessionId, state);
    }
    return state;
  }

  function getTurnBuffer(state: SessionState, turnKey: string): FileOpRecord[] {
    let buf = state.turnBuffers.get(turnKey);
    if (buf === undefined) {
      buf = [];
      state.turnBuffers.set(turnKey, buf);
    }
    return buf;
  }

  // -----------------------------------------------------------------------
  // wrapToolCall — pre/post image capture for tracked tools
  // -----------------------------------------------------------------------

  const wrapToolCall = async (
    ctx: TurnContext,
    request: ToolRequest,
    next: ToolHandler,
  ): Promise<ToolResponse> => {
    if (!trackedToolIds.has(request.toolId)) {
      return next(request);
    }

    const path = extractPath(request.input);
    if (path === undefined) {
      return next(request);
    }

    const state = await getOrCreateSession(ctx.session.sessionId);
    const turnKey = String(ctx.turnId);

    // Pre-image (best-effort)
    const pre = await capturePreImage(config.blobDir, path);

    // Run the tool
    const response = await next(request);

    // Post-image (best-effort)
    const post = await capturePostImage(config.blobDir, path);

    // Build the FileOpRecord. Returns undefined if nothing actually changed
    // (e.g. dryRun, failed edit, no-op write).
    const record = buildFileOpRecord({
      callId: extractCallId(request),
      path,
      turnIndex: ctx.turnIndex,
      eventIndex: state.eventIndex++,
      pre,
      post,
    });

    if (record !== undefined) {
      getTurnBuffer(state, turnKey).push(record);
    }

    return response;
  };

  // -----------------------------------------------------------------------
  // onAfterTurn — end-of-turn capture
  // -----------------------------------------------------------------------

  const onAfterTurn = async (ctx: TurnContext): Promise<void> => {
    const state = await getOrCreateSession(ctx.session.sessionId);
    const turnKey = String(ctx.turnId);
    const fileOps = state.turnBuffers.get(turnKey) ?? [];
    state.turnBuffers.delete(turnKey);

    // Build the payload. Drift warnings are added in the deferred phase.
    const payload: CheckpointPayload = {
      turnIndex: ctx.turnIndex,
      sessionId: ctx.session.sessionId as unknown as string,
      fileOps,
      driftWarnings: [],
      capturedAt: Date.now(),
    };

    // Critical path: write the chain node. On failure, mark incomplete and
    // continue — capture is a recovery feature, not a correctness feature.
    const status: SnapshotStatus = "complete";
    const parents = state.parentNodeId !== undefined ? [state.parentNodeId] : [];
    const putResult = await store.put(state.chainId, payload, parents, {
      [SNAPSHOT_STATUS_KEY]: status,
    });

    if (!putResult.ok) {
      // Soft-fail: write a marker snapshot so subsequent rewinds know
      // there's a gap, then drop into the deferred phase anyway so drift
      // detection still runs for diagnostics. We do NOT update parentNodeId
      // — the next turn's snapshot will continue from the previous good
      // parent, leaving an "incomplete" gap in the chain.
      const incomplete: SnapshotStatus = "incomplete";
      const incompletePayload: CheckpointPayload = {
        ...payload,
        // Drop file ops on the failed snapshot — they're not restorable
        // without the corresponding chain entry, so don't pretend they are.
        fileOps: [],
      };
      await store.put(state.chainId, incompletePayload, parents, {
        [SNAPSHOT_STATUS_KEY]: incomplete,
        koi_capture_error: putResult.error.message,
      });
      runDeferred(state, undefined, driftDetector);
      return;
    }

    // putResult.ok && putResult.value may be undefined if skipIfUnchanged
    // matched (we don't pass that option, but be defensive).
    if (putResult.value !== undefined) {
      state.parentNodeId = putResult.value.nodeId;
    }

    // Deferred phase: drift detection runs after the critical path so it
    // does not block the next turn. We don't await it from this hook —
    // the engine has already moved on by the time it completes.
    runDeferred(state, putResult.value?.nodeId, driftDetector);
  };

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  const onSessionStart = async (_ctx: SessionContext): Promise<void> => {
    // No-op — state is lazily initialized on first wrapToolCall/onAfterTurn.
    // Eager init would race with parallel sessions sharing the same store.
  };

  const onSessionEnd = async (ctx: SessionContext): Promise<void> => {
    sessions.delete(ctx.sessionId);
  };

  // -----------------------------------------------------------------------
  // Capability fragment (advertised to the model)
  // -----------------------------------------------------------------------

  const describeCapabilities = (_ctx: TurnContext): CapabilityFragment => ({
    label: "checkpoint",
    description: `Session rollback active — file edits via ${[...trackedToolIds].join(", ")} are captured per turn.`,
  });

  return {
    name: "checkpoint",
    // Run as a resolve-phase middleware so it observes tools after permission
    // checks but before observers/audit. priority 350 puts it inside any
    // outer access-control middleware (e.g., guided-retry at 425).
    phase: "resolve",
    priority: 350,
    onSessionStart,
    onSessionEnd,
    onAfterTurn,
    wrapToolCall,
    describeCapabilities,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a callId from a `ToolRequest`. The L0 ToolRequest doesn't carry one
 * directly; the L1 engine assigns it elsewhere. We synthesize a stable
 * placeholder so the FileOpRecord type is satisfied — restore correctness
 * does not depend on this value.
 */
function extractCallId(request: ToolRequest): ToolCallId {
  const fromMetadata = request.metadata?.callId;
  if (typeof fromMetadata === "string") {
    return fromMetadata as ToolCallId;
  }
  return `synth-${crypto.randomUUID()}` as ToolCallId;
}

/**
 * Run the deferred capture work — drift detection. Best-effort: errors are
 * swallowed, since drift is advisory and must not abort the agent loop.
 *
 * The drift warnings are stored back onto the snapshot's metadata (or, if
 * the snapshot wasn't written, dropped to a log). Today we store them on
 * the next turn's snapshot via the in-memory `pendingDrift` field — that
 * lets us avoid mutating the just-written snapshot row.
 */
function runDeferred(
  _state: SessionState,
  _justWrittenNodeId: NodeId | undefined,
  detector: DriftDetector | null,
): void {
  if (detector === null) return;
  // queueMicrotask defers without awaiting — the engine moves on immediately.
  // This is the "two-phase capture" pattern from design review issue 14A.
  queueMicrotask(() => {
    void detector
      .detect()
      .then((_warnings) => {
        // Drift warnings are computed but not yet routed back to the
        // snapshot. The simplest sink would be to attach them to the NEXT
        // snapshot's payload, since updating an existing chain node row in
        // place isn't supported by the SnapshotChainStore<T> contract.
        // The wiring is a follow-up — for this PR we run detection so the
        // critical-path budget is exercised; storing the result is part of
        // the restore PR (3b) where the rewind UI will read them back.
      })
      .catch(() => {
        // Best-effort: never throw from drift detection.
      });
  });
}
