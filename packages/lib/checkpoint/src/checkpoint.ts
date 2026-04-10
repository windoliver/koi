/**
 * `createCheckpoint` — the public factory for `@koi/checkpoint`.
 *
 * Returns a `Checkpoint` object containing both the `KoiMiddleware` (to
 * register with `createKoi`) and the programmatic `rewind`/`rewindTo`
 * methods. Capture and rewind share state via closure inside this factory:
 *
 *   - `sessions`        per-session capture state (parent pointer, turn buffers)
 *   - `tracker`         engine state (idle vs tool-running) for in-flight queue
 *   - `serializer`      per-session promise chain for rewind requests
 *
 * The middleware's `wrapToolCall` updates `tracker` so the rewind methods
 * know when to queue. The rewind methods read the chain via the same store
 * the middleware writes to. Both halves see the same parent pointer cache.
 *
 * Capture flow lives in this file alongside rewind so they can share state
 * without exposing internals across module boundaries. The legacy
 * `createCheckpointMiddleware` factory in `checkpoint-middleware.ts` is now
 * a thin wrapper that returns just the middleware half.
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
import { createInFlightTracker, createRewindSerializer } from "./in-flight-queue.js";
import { runRestore } from "./restore-protocol.js";
import type {
  Checkpoint,
  CheckpointMiddlewareConfig,
  CheckpointPayload,
  DriftDetector,
  RewindResult,
} from "./types.js";

const DEFAULT_TRACKED_TOOLS = ["fs_edit", "fs_write"] as const;

/**
 * Per-session capture state. One entry per active session.
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

export interface CreateCheckpointInput {
  /**
   * Chain store implementing the L0 `SnapshotChainStore<CheckpointPayload>`
   * interface. The factory doesn't import any concrete implementation —
   * the runtime injects one (typically `@koi/snapshot-store-sqlite`).
   */
  readonly store: SnapshotChainStore<CheckpointPayload>;
  /** Configuration: blob dir, tracked tool IDs, drift detector. */
  readonly config: CheckpointMiddlewareConfig;
}

/**
 * Create a `Checkpoint` instance — both middleware and rewind methods,
 * sharing per-session state via closure.
 */
export function createCheckpoint(input: CreateCheckpointInput): Checkpoint {
  const { store, config } = input;
  const trackedToolIds = new Set(config.trackedToolIds ?? DEFAULT_TRACKED_TOOLS);
  const driftDetector: DriftDetector | null =
    config.driftDetector === undefined
      ? createGitStatusDriftDetector(process.cwd())
      : config.driftDetector;

  const sessions = new Map<SessionId, SessionState>();
  const tracker = createInFlightTracker();
  const serializer = createRewindSerializer(tracker);

  // -----------------------------------------------------------------------
  // Per-session state helpers (shared by capture and rewind)
  // -----------------------------------------------------------------------

  async function getOrCreateSession(sessionId: SessionId): Promise<SessionState> {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      const cid = chainId(sessionId as unknown as string);
      // Reads back the existing head if the session is being resumed from disk.
      // `await` is a no-op when the store impl is sync (e.g., SQLite).
      const headResult = await store.head(cid);
      let parent =
        headResult.ok && headResult.value !== undefined ? headResult.value.nodeId : undefined;

      // Bootstrap: a brand-new session gets an initial empty snapshot so the
      // first real turn has a predecessor to rewind TO. Without this, the
      // first captured turn would be the root of the chain, and
      // `rewind 1` would land ON the root (keeping its file ops applied)
      // rather than undoing them. The protocol's snapshotsToUndo excludes
      // the target snapshot — so we need a target that has no ops.
      if (parent === undefined) {
        const bootstrapPayload: CheckpointPayload = {
          turnIndex: -1,
          sessionId: sessionId as unknown as string,
          fileOps: [],
          driftWarnings: [],
          capturedAt: Date.now(),
        };
        const bootstrapResult = await store.put(cid, bootstrapPayload, [], {
          [SNAPSHOT_STATUS_KEY]: "complete",
          koi_bootstrap: true,
        });
        if (bootstrapResult.ok && bootstrapResult.value !== undefined) {
          parent = bootstrapResult.value.nodeId;
        }
      }

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
  // wrapToolCall — pre/post image capture + in-flight tracking
  // -----------------------------------------------------------------------

  const wrapToolCall = async (
    ctx: TurnContext,
    request: ToolRequest,
    next: ToolHandler,
  ): Promise<ToolResponse> => {
    const sid = ctx.session.sessionId;
    // Mark this session as having an active tool call so concurrent rewind
    // requests are queued instead of racing with the capture path.
    tracker.enterTool(sid);
    try {
      if (!trackedToolIds.has(request.toolId)) {
        return await next(request);
      }

      const rawPath = extractPath(request.input);
      if (rawPath === undefined) {
        return await next(request);
      }

      // Resolve the tool-input path to the real filesystem path. Without
      // this, virtualized backends like @koi/fs-local (which maps
      // "/workspace/foo" → "<cwd>/workspace/foo") would silently cause the
      // middleware to read from a non-existent path and capture nothing.
      // Default is identity — unit tests and unsandboxed setups unchanged.
      const path = config.resolvePath !== undefined ? config.resolvePath(rawPath) : rawPath;

      const state = await getOrCreateSession(sid);
      const turnKey = String(ctx.turnId);

      // Pre-image (best-effort)
      const pre = await capturePreImage(config.blobDir, path);

      // Run the tool
      const response = await next(request);

      // Post-image (best-effort)
      const post = await capturePostImage(config.blobDir, path);

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
    } finally {
      tracker.exitTool(sid);
    }
  };

  // -----------------------------------------------------------------------
  // onAfterTurn — end-of-turn capture
  // -----------------------------------------------------------------------

  const onAfterTurn = async (ctx: TurnContext): Promise<void> => {
    const state = await getOrCreateSession(ctx.session.sessionId);
    const turnKey = String(ctx.turnId);
    const fileOps = state.turnBuffers.get(turnKey) ?? [];
    state.turnBuffers.delete(turnKey);

    // If a transcript is wired in, capture the post-turn entry count so the
    // restore protocol can truncate back to this point on rewind. The session
    // middleware appends entries during wrapToolCall/wrapModelStream which
    // run BEFORE onAfterTurn, so the count we read here is the count at the
    // boundary between this turn and the next.
    let transcriptEntryCount: number | undefined;
    if (config.transcript !== undefined) {
      try {
        const loadResult = await config.transcript.load(ctx.session.sessionId);
        if (loadResult.ok) {
          transcriptEntryCount = loadResult.value.entries.length;
        }
      } catch {
        // Best-effort: if the load fails, the snapshot just doesn't carry
        // a count and rewind won't touch the transcript for this turn.
      }
    }

    const payload: CheckpointPayload =
      transcriptEntryCount !== undefined
        ? {
            turnIndex: ctx.turnIndex,
            sessionId: ctx.session.sessionId as unknown as string,
            fileOps,
            driftWarnings: [],
            transcriptEntryCount,
            capturedAt: Date.now(),
          }
        : {
            turnIndex: ctx.turnIndex,
            sessionId: ctx.session.sessionId as unknown as string,
            fileOps,
            driftWarnings: [],
            capturedAt: Date.now(),
          };

    // Critical path: write the chain node. Soft-fail on error per Issue 8A.
    const status: SnapshotStatus = "complete";
    const parents = state.parentNodeId !== undefined ? [state.parentNodeId] : [];
    const putResult = await store.put(state.chainId, payload, parents, {
      [SNAPSHOT_STATUS_KEY]: status,
    });

    if (!putResult.ok) {
      // Soft-fail: write a marker snapshot so subsequent rewinds know there's
      // a gap. We do NOT update parentNodeId — the next turn's snapshot will
      // continue from the previous good parent, leaving an "incomplete" gap.
      const incomplete: SnapshotStatus = "incomplete";
      const incompletePayload: CheckpointPayload = { ...payload, fileOps: [] };
      await store.put(state.chainId, incompletePayload, parents, {
        [SNAPSHOT_STATUS_KEY]: incomplete,
        koi_capture_error: putResult.error.message,
      });
      runDeferred(driftDetector);
      return;
    }

    if (putResult.value !== undefined) {
      state.parentNodeId = putResult.value.nodeId;
    }

    runDeferred(driftDetector);
  };

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  const onSessionEnd = async (ctx: SessionContext): Promise<void> => {
    sessions.delete(ctx.sessionId);
  };

  const describeCapabilities = (_ctx: TurnContext): CapabilityFragment => ({
    label: "checkpoint",
    description: `Session rollback active — file edits via ${[...trackedToolIds].join(", ")} are captured per turn.`,
  });

  const middleware: KoiMiddleware = {
    name: "checkpoint",
    phase: "resolve",
    priority: 350,
    onSessionEnd,
    onAfterTurn,
    wrapToolCall,
    describeCapabilities,
  };

  // -----------------------------------------------------------------------
  // Rewind methods (programmatic API)
  // -----------------------------------------------------------------------

  /**
   * Run the restore protocol for a session. Refreshes the in-memory parent
   * pointer cache so the next captured turn chains off the new rewind marker
   * rather than the pre-rewind head.
   *
   * If a `transcript` is wired into config, also calls
   * `transcript.truncate(sid, target.transcriptEntryCount)` so the
   * conversation log shrinks back to the same boundary as the file state.
   */
  async function doRewind(
    sessionId: SessionId,
    target: { kind: "by-count"; n: number } | { kind: "by-node"; targetNodeId: NodeId },
  ): Promise<RewindResult> {
    const state = await getOrCreateSession(sessionId);
    // Build the RestoreInput conditionally so we omit `transcript` entirely
    // when none is wired (exactOptionalPropertyTypes forbids passing undefined).
    const result = await runRestore(
      config.transcript !== undefined
        ? {
            store,
            chainId: state.chainId,
            blobDir: config.blobDir,
            target,
            transcript: config.transcript,
            sessionId,
          }
        : {
            store,
            chainId: state.chainId,
            blobDir: config.blobDir,
            target,
          },
    );
    if (result.ok) {
      // Refresh the parent pointer so the next captured turn chains off the
      // rewind marker, not the old pre-rewind head.
      state.parentNodeId = result.newHeadNodeId;
      // Clear any in-flight turn buffers — they refer to ops that were
      // (or are about to be) undone by the restore.
      state.turnBuffers.clear();
    }
    return result;
  }

  const rewind = (sessionId: SessionId, n: number): Promise<RewindResult> =>
    serializer.schedule(sessionId, () => doRewind(sessionId, { kind: "by-count", n }));

  const rewindTo = (sessionId: SessionId, targetNodeId: NodeId): Promise<RewindResult> =>
    serializer.schedule(sessionId, () => doRewind(sessionId, { kind: "by-node", targetNodeId }));

  const currentHead = async (sessionId: SessionId): Promise<NodeId | undefined> => {
    const state = await getOrCreateSession(sessionId);
    return state.parentNodeId;
  };

  return {
    middleware,
    rewind,
    rewindTo,
    currentHead,
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
 * Drift warnings are computed but not yet routed back into a snapshot. The
 * sink (rewind UI displaying them on rewind) is the next integration step.
 */
function runDeferred(detector: DriftDetector | null): void {
  if (detector === null) return;
  // queueMicrotask defers without awaiting — the engine moves on immediately.
  // This is the "two-phase capture" pattern from design review issue 14A.
  queueMicrotask(() => {
    void detector
      .detect()
      .then(() => {
        // Detection runs to exercise the critical-path budget. Persisting
        // the results is part of the runtime wiring PR.
      })
      .catch(() => {
        // Best-effort: never throw from drift detection.
      });
  });
}
