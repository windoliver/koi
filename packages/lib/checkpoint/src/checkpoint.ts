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
import { applyCompensatingOps, toCompensating } from "./compensating-ops.js";
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
  /**
   * User-turn counter. 0 = the bootstrap snapshot. Each real user prompt
   * increments this, and all engine turns within a prompt share the same
   * value (see onAfterTurn's continuation heuristic).
   */
  userTurnCounter: number;
  /**
   * Whether the most recent captured snapshot had non-empty fileOps.
   * Used by the onAfterTurn continuation heuristic — if true AND the
   * current capture is empty, this is a post-tool-summary engine turn
   * and should share the prior's userTurnIndex.
   */
  lastCaptureHadOps: boolean;
  /**
   * Set when compensating rollback AND incomplete-snapshot persistence
   * BOTH fail on a stopBlocked turn (#1638). The workspace is known to
   * diverge from the last good snapshot and we have no audit record,
   * so subsequent capture writes (wrapToolCall, normal onAfterTurn)
   * fail closed until the session is repaired. Null = not quarantined.
   */
  quarantine: { readonly reason: string; readonly at: number } | null;
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

  /**
   * Persist the fact that a stopBlocked turn's compensating rollback did
   * NOT fully complete. The existing `incomplete` snapshot contract
   * (soft-fail capture, restore/resume skip) requires empty `fileOps`,
   * so we encode the mutation log in metadata instead — operators retain
   * an audit trail; the restore/head/resume paths keep their existing
   * "incomplete means non-restorable marker" semantics unchanged.
   *
   * parentNodeId is intentionally not advanced, so the live chain head
   * stays at the last fully-complete snapshot and subsequent turns fork
   * from there. Soft-fail on persistence error — we've already logged.
   */
  async function persistIncompleteStopBlocked(
    state: SessionState,
    ctx: TurnContext,
    fileOps: readonly FileOpRecord[],
    unsuccessful: readonly unknown[],
  ): Promise<{ readonly ok: boolean }> {
    try {
      // Do NOT advance state.userTurnCounter: the incomplete marker is a
      // sibling of the live ancestor chain (parentNodeId isn't updated),
      // so restore planning's by-count walk on the live chain never
      // traverses it. Bumping the counter would create a gap in the
      // live chain's userTurnIndex sequence, which makes the by-count
      // resolver fall past the aborted turn and over-rewind by one
      // prompt. Reuse the current counter so the marker is tagged with
      // the previous prompt's index; subsequent successful turns
      // continue the contiguous sequence.
      const parents = state.parentNodeId !== undefined ? [state.parentNodeId] : [];
      const payload: CheckpointPayload = {
        turnIndex: ctx.turnIndex,
        userTurnIndex: state.userTurnCounter,
        sessionId: ctx.session.sessionId as unknown as string,
        fileOps: [], // empty — matches existing incomplete-snapshot contract
        driftWarnings: [],
        capturedAt: Date.now(),
      };
      // Serialize the dropped ops into metadata for operators. `store.put`
      // metadata is JSON; keep entries shape-stable so external tooling
      // can parse without knowing the full FileOpRecord shape.
      const droppedOps = fileOps.map((op) => {
        return { kind: op.kind, path: op.path, eventIndex: op.eventIndex };
      });
      const incompleteStatus: SnapshotStatus = "incomplete";
      const putResult = await store.put(state.chainId, payload, parents, {
        [SNAPSHOT_STATUS_KEY]: incompleteStatus,
        koi_stop_blocked: true,
        koi_rollback_failed: true,
        koi_rollback_unsuccessful_count: unsuccessful.length,
        koi_rollback_dropped_ops: droppedOps,
        ...(ctx.stopGateReason !== undefined ? { koi_stop_reason: ctx.stopGateReason } : {}),
      });
      if (!putResult.ok) {
        console.error(
          "[koi:checkpoint] incomplete-snapshot persist returned error on stopBlocked turn:",
          putResult.error,
        );
        return { ok: false };
      }
      return { ok: true };
    } catch (e: unknown) {
      console.error(
        "[koi:checkpoint] failed to persist incomplete snapshot for stopBlocked turn:",
        e,
      );
      return { ok: false };
    }
  }

  // -----------------------------------------------------------------------
  // Per-session state helpers (shared by capture and rewind)
  // -----------------------------------------------------------------------

  /**
   * Resolve the live parent for a resumed session. When `store.head()`
   * points at an `incomplete` marker (soft-fail or rollback-failed
   * stopBlocked), walk up the `parentIds` chain to the nearest `complete`
   * ancestor. Returns `undefined` when no complete ancestor exists (the
   * bootstrap hasn't been written yet).
   *
   * Cycle guard: walk at most 64 hops — the chain is linear in practice,
   * so a non-terminating traversal indicates corrupted metadata and
   * should abort resolution rather than loop forever.
   */
  async function resolveLiveParent(
    cid: ReturnType<typeof chainId>,
    headResult: Awaited<ReturnType<typeof store.head>>,
  ): Promise<NodeId | undefined> {
    if (!headResult.ok || headResult.value === undefined) return undefined;
    const maxHops = 64;
    let node = headResult.value;
    for (let hop = 0; hop < maxHops; hop += 1) {
      const status = node.metadata[SNAPSHOT_STATUS_KEY];
      if (status !== "incomplete") return node.nodeId;
      const parentId = node.parentIds[0];
      if (parentId === undefined) return undefined;
      const parentResult = await store.get(parentId);
      if (!parentResult.ok) return undefined;
      node = parentResult.value;
    }
    // Metadata corruption — surface but don't crash.
    console.error(
      `[koi:checkpoint] resolveLiveParent exceeded ${maxHops} hops in chain ${cid}; treating as no parent`,
    );
    return undefined;
  }

  async function getOrCreateSession(sessionId: SessionId): Promise<SessionState> {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      const cid = chainId(sessionId as unknown as string);
      // Reads back the existing head if the session is being resumed from disk.
      // `await` is a no-op when the store impl is sync (e.g., SQLite).
      const headResult = await store.head(cid);
      // On restart, the store's head may be an `incomplete` marker
      // (persistence soft-fail or rollback-failed stopBlocked turn).
      // Resuming from an incomplete marker would fork the chain off a
      // non-restorable node and leave any still-dirty workspace state
      // invisible to rewind. Walk back through parents to the most
      // recent `complete` ancestor instead, keeping the incomplete
      // markers as persisted audit records without making them part of
      // the live capture chain.
      let parent = await resolveLiveParent(cid, headResult);

      // Bootstrap: a brand-new session gets an initial empty snapshot so the
      // first real turn has a predecessor to rewind TO. Without this, the
      // first captured turn would be the root of the chain, and
      // `rewind 1` would land ON the root (keeping its file ops applied)
      // rather than undoing them. The protocol's snapshotsToUndo excludes
      // the target snapshot — so we need a target that has no ops.
      //
      // The bootstrap has `userTurnIndex: 0`; real user prompts start at 1.
      if (parent === undefined) {
        // Bootstrap represents the pre-any-prompt state. `transcriptEntryCount`
        // must be 0 so rewind-to-bootstrap truncates the JSONL to zero entries
        // (unlinking the file) — otherwise the display would still show
        // conversation that semantically shouldn't exist.
        const bootstrapPayload: CheckpointPayload = {
          turnIndex: -1,
          userTurnIndex: 0,
          sessionId: sessionId as unknown as string,
          fileOps: [],
          driftWarnings: [],
          transcriptEntryCount: 0,
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

      // Restore userTurnCounter from the LIVE parent (the complete
      // ancestor we just resolved), not from the raw store head — the
      // raw head might be an incomplete marker whose userTurnIndex we
      // consumed for audit purposes. Using that value would cause the
      // next successful turn to share an index with the aborted marker.
      let userTurnCounter = 0;
      if (parent !== undefined) {
        const parentResult = await store.get(parent);
        if (parentResult.ok) {
          userTurnCounter = parentResult.value.data.userTurnIndex ?? 0;
        }
      }

      state = {
        chainId: cid,
        parentNodeId: parent,
        turnBuffers: new Map(),
        eventIndex: 0,
        userTurnCounter,
        lastCaptureHadOps: false,
        quarantine: null,
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
      //
      // Security: when the resolver returns `undefined`, the input path
      // resolves OUTSIDE the backend's workspace root (traversal, unmatched
      // absolute path, etc.). We MUST NOT hash or store that file — the
      // backend's own safePath() will reject the op later, but the
      // checkpoint middleware runs first and would leak the file into the
      // blob store. Skip capture entirely and forward to the tool; the
      // backend will return a PERMISSION error which surfaces to the
      // caller without any side effects on the checkpoint chain.
      //
      // Default (resolvePath omitted) is identity — unit tests and
      // unsandboxed setups unchanged.
      let path: string;
      if (config.resolvePath !== undefined) {
        const resolved = config.resolvePath(rawPath);
        if (resolved === undefined) {
          return await next(request);
        }
        path = resolved;
      } else {
        path = rawPath;
      }

      const state = await getOrCreateSession(sid);
      // #1638 fail-closed: after a double-failure (rollback + persist)
      // the session is quarantined — refuse further tracked mutations
      // so the checkpoint chain cannot diverge further from disk. The
      // untracked fast-path above has already returned, so only
      // tracked tools (fs_edit, fs_write) are blocked here.
      if (state.quarantine !== null) {
        throw new Error(
          `[koi:checkpoint] session ${sid} is quarantined: ${state.quarantine.reason}. ` +
            "Repair the workspace and clear the quarantine before continuing.",
        );
      }
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
        ...(config.backendName !== undefined ? { backend: config.backendName } : {}),
      });

      if (record !== undefined) {
        getTurnBuffer(state, turnKey).push(record);
      }

      ctx.reportDecision?.({
        action: "capture",
        toolId: request.toolId,
        path,
        captured: record !== undefined,
      });

      return response;
    } finally {
      tracker.exitTool(sid);
    }
  };

  // -----------------------------------------------------------------------
  // onAfterTurn — end-of-turn capture
  // -----------------------------------------------------------------------

  const onAfterTurn = async (ctx: TurnContext): Promise<void> => {
    const sid = ctx.session.sessionId;
    // Mark the session busy for the entire post-turn window. wrapToolCall
    // brackets the tool call itself but returns before onAfterTurn runs,
    // so without this the session is "idle" for anything between the last
    // tool call completing and this hook finishing. A rewind requested in
    // that window (e.g. user hits /rewind the moment the last tool call
    // returns, before the sync drift detector finishes) would run against
    // the PREVIOUS head — the just-finished turn's snapshot wouldn't exist
    // yet. Then this hook resumes and writes the turn's snapshot AFTER the
    // rewind marker, corrupting the chain (v1 -> v2, rewind(1) can land
    // at bootstrap instead of v1). Bracketing onAfterTurn as busy keeps
    // rewinds queued behind it via RewindSerializer.waitForIdle().
    // See codex round 3, P1 on commit 6eb8604a.
    tracker.enterTool(sid);
    try {
      return await runOnAfterTurn(ctx);
    } finally {
      tracker.exitTool(sid);
    }
  };

  const runOnAfterTurn = async (ctx: TurnContext): Promise<void> => {
    const state = await getOrCreateSession(ctx.session.sessionId);
    const turnKey = String(ctx.turnId);
    const fileOps = state.turnBuffers.get(turnKey) ?? [];

    // #1638 / stop-gate: a non-normal turn completion (activity-timeout
    // abort, stop-gate veto) must NOT advance the rewind chain head to a
    // "complete" snapshot — a later /rewind could land on partial state.
    //
    // If the interrupted turn already mutated the workspace, we actively
    // apply compensating ops to roll the disk back. When every op lands
    // cleanly, the buffer is discarded and the chain head stays at the
    // previous good snapshot. When any op fails (explicit error OR
    // `skipped-missing-blob` — the target blob is gone so the restore
    // couldn't run), we fail closed: preserve the fileOps by writing an
    // `incomplete` marker snapshot so operators still have an audit
    // trail + potential recovery path. If persistence ALSO fails (e.g.
    // storage corruption), we retain the buffer in memory and flag the
    // session as quarantined — subsequent capture writes are blocked
    // until the buffer is either consumed or manually cleared.
    if (ctx.stopBlocked === true) {
      // Reset the continuation marker so the NEXT successful turn cannot
      // mistakenly fold into the turn BEFORE the aborted one. Without
      // this, `lastCaptureHadOps` stays `true` from the prior normal
      // turn's tool-call and the heuristic would treat a subsequent
      // text-only turn as a continuation of the pre-abort turn,
      // producing an incorrect shared `userTurnIndex` and breaking
      // `/rewind` granularity. Aborted turns do not participate in the
      // "same-user-prompt" grouping.
      state.lastCaptureHadOps = false;
      if (fileOps.length === 0) {
        state.turnBuffers.delete(turnKey);
        return;
      }
      let rollbackCleanlyDone = false;
      let unsuccessful: readonly unknown[] = [];
      try {
        const compensating = fileOps
          .slice()
          .sort((a, b) => b.eventIndex - a.eventIndex)
          .map(toCompensating);
        const results = await applyCompensatingOps(compensating, config.blobDir, config.backends);
        unsuccessful = results.filter(
          (r) => r.kind === "error" || r.kind === "skipped-missing-blob",
        );
        if (unsuccessful.length === 0) {
          rollbackCleanlyDone = true;
        } else {
          console.error(
            `[koi:checkpoint] rollback incomplete on stopBlocked turn — ${unsuccessful.length} op(s) not restored:`,
            unsuccessful,
          );
        }
      } catch (e: unknown) {
        console.error("[koi:checkpoint] compensating rollback threw on stopBlocked turn:", e);
        unsuccessful = [{ kind: "error", path: "<thrown>", cause: e }];
      }
      if (rollbackCleanlyDone) {
        state.turnBuffers.delete(turnKey);
        return;
      }
      // Rollback did NOT fully apply. Try to persist an incomplete marker
      // as the audit record; keep the buffer alive if persistence also
      // fails so disk-vs-chain divergence can still be recovered.
      const persistResult = await persistIncompleteStopBlocked(state, ctx, fileOps, unsuccessful);
      if (persistResult.ok) {
        state.turnBuffers.delete(turnKey);
      } else {
        // Double failure: workspace diverges from last good snapshot AND
        // we have no durable audit record. Quarantine the session so
        // subsequent tracked mutations / normal captures fail closed
        // instead of compounding the divergence.
        state.quarantine = {
          reason: "rollback failed AND incomplete-snapshot persist failed on stopBlocked turn",
          at: Date.now(),
        };
        console.error(
          "[koi:checkpoint] rollback AND incomplete-snapshot persistence both failed on stopBlocked turn — " +
            "session quarantined; subsequent captures will fail closed until repaired",
        );
      }
      return;
    }

    // Normal-completion path: refuse to advance the chain for a
    // quarantined session — any new capture would build on top of known-
    // divergent disk state.
    if (state.quarantine !== null) {
      console.error(
        `[koi:checkpoint] session ${state.chainId} is quarantined; skipping onAfterTurn capture:`,
        state.quarantine.reason,
      );
      state.turnBuffers.delete(turnKey);
      return;
    }

    // Normal completed turn — safe to clear the per-turn buffer now that
    // we've read `fileOps`. The stopBlocked branch above manages its own
    // buffer lifecycle based on rollback/persistence outcome.
    state.turnBuffers.delete(turnKey);

    // User-turn boundary detection. A single user prompt that invokes tools
    // typically produces two engine turns:
    //   engine turn N   — model call → tool call(s) → fileOps populated
    //   engine turn N+1 — post-tool summary model call → fileOps empty
    // Both share the same user prompt, so `/rewind 1` should undo both.
    //
    // Heuristic: if the previous capture had non-empty fileOps AND this
    // capture is empty, treat it as a continuation of the same user turn.
    // Otherwise increment the counter. This correctly groups tool-call
    // flows while still treating consecutive text-only turns as separate.
    const isContinuation = state.lastCaptureHadOps && fileOps.length === 0;
    if (!isContinuation) {
      state.userTurnCounter += 1;
    }
    const userTurnIndex = state.userTurnCounter;
    // Update the "previous capture had ops" marker for the NEXT call.
    // We set it based on the CURRENT fileOps so the next onAfterTurn can
    // reference it. Setting it after the put would be the same behavior
    // (the put is synchronous from our perspective) — putting it here is
    // just clearer.
    state.lastCaptureHadOps = fileOps.length > 0;

    // If a transcript is wired in, capture the post-turn entry count so the
    // restore protocol can truncate back to this point on rewind. This relies
    // on @koi/query-engine's `consumeModelStream` awaiting its iterator
    // cleanup before yielding `turn_end` — without that await, the
    // session-transcript middleware's `wrapModelStream` finally-block writes
    // race the engine's `onAfterTurn` dispatch and this read returns zero.
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

    // Drift detection runs synchronously so warnings land in the INITIAL
    // snapshot payload. An earlier two-phase approach (put first, persist
    // drift via a deferred updatePayload) was reverted after codex review
    // found two problems:
    //   1. Timing race: the deferred detector could resolve after the next
    //      turn started, attributing later-turn drift to the wrong snapshot.
    //   2. Fork safety: `store.updatePayload` mutates rows shared across
    //      forks — rewriting history for any branch that already referenced
    //      the node. SnapshotNode is supposed to be immutable.
    // Sync detection costs `git status` latency on the critical path
    // (bounded by the detector's own 1.5s timeout and a "return [] on any
    // failure" contract). Accurate but slightly slower; correct invariant.
    let driftWarnings: readonly string[] = [];
    if (driftDetector !== null) {
      try {
        driftWarnings = await driftDetector.detect();
      } catch {
        // Never throw from drift detection — treat any error as "no drift".
      }
    }

    const payload: CheckpointPayload =
      transcriptEntryCount !== undefined
        ? {
            turnIndex: ctx.turnIndex,
            userTurnIndex,
            sessionId: ctx.session.sessionId as unknown as string,
            fileOps,
            driftWarnings,
            transcriptEntryCount,
            capturedAt: Date.now(),
          }
        : {
            turnIndex: ctx.turnIndex,
            userTurnIndex,
            sessionId: ctx.session.sessionId as unknown as string,
            fileOps,
            driftWarnings,
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
      return;
    }

    if (putResult.value !== undefined) {
      state.parentNodeId = putResult.value.nodeId;
    }
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
    // Build the RestoreInput conditionally so we omit optional fields entirely
    // when they are absent (exactOptionalPropertyTypes forbids passing undefined).
    const result = await runRestore({
      store,
      chainId: state.chainId,
      blobDir: config.blobDir,
      target,
      ...(config.transcript !== undefined ? { transcript: config.transcript, sessionId } : {}),
      ...(config.backends !== undefined ? { backends: config.backends } : {}),
    });
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

  /**
   * Reset checkpoint state for a session — evicts the in-memory
   * `SessionState` and prunes every node in the chain from the
   * backing store so a subsequent capture bootstraps a fresh chain.
   *
   * Intended for hosts that reuse a session id across explicit
   * conversation boundaries (e.g. `koi tui`'s `/clear` keeps the
   * session id stable so the JSONL filename and the post-quit
   * resume hint stay valid, but wants true checkpoint isolation
   * so `/rewind` after quit + resume cannot walk back into pre-
   * clear snapshots).
   *
   * Safe to call even when no chain exists yet. Pruning errors are
   * surfaced as a rejected promise so callers can fail-closed
   * (hosts typically flag the reset as unpersisted and suppress
   * the resume hint rather than silently advertising a chain that
   * may still contain pre-clear history).
   */
  const resetSession = (sessionId: SessionId): Promise<void> =>
    // Route through the same per-session serializer rewind uses so
    // a `/clear` on a reused session id cannot interleave with a
    // queued or in-flight rewind. Without this gate, an old rewind
    // could run AFTER the prune (against a freshly bootstrapped
    // chain) or race the prune mid-transaction — either case
    // resurrects pre-clear file/snapshot state and breaks the
    // isolation contract this method exists to enforce. The
    // serializer also waits for any active tool call via the
    // shared in-flight tracker, so capture and reset are mutually
    // exclusive on the same session.
    serializer.schedule(sessionId, async () => {
      sessions.delete(sessionId);
      const cid = chainId(sessionId as unknown as string);
      // retainCount: 0 + retainBranches: false removes every node,
      // including the head — the sqlite backend drops the head row
      // and the in-memory head cache when the last member goes,
      // leaving the chain empty. The next getOrCreateSession call
      // will re-bootstrap a fresh root snapshot.
      const pruneResult = await store.prune(cid, {
        retainCount: 0,
        retainBranches: false,
      });
      if (!pruneResult.ok) {
        const cause = pruneResult.error.cause;
        const causeMsg =
          cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : undefined;
        throw new Error(
          `checkpoint.resetSession(${sessionId}) failed: ${pruneResult.error.message}${
            causeMsg !== undefined ? ` — ${causeMsg}` : ""
          }`,
          { cause: pruneResult.error },
        );
      }
    });

  return {
    middleware,
    rewind,
    rewindTo,
    currentHead,
    resetSession,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a callId from a `ToolRequest`. The turn-runner now sets the
 * per-invocation id on the dedicated `ToolRequest.callId` field
 * (#1759 round 6) so checkpoint snapshots can correlate file ops to the
 * exact tool invocation that produced them. Falls back to
 * `metadata.callId` for any older caller still using the legacy path,
 * then to a synthetic UUID so FileOpRecord stays well-formed even when
 * neither is set. Restore correctness does not depend on the value, but
 * rewind / debug / audit workflows expect a stable real id.
 */
function extractCallId(request: ToolRequest): ToolCallId {
  if (typeof request.callId === "string") {
    return request.callId as ToolCallId;
  }
  const fromMetadata = request.metadata?.callId;
  if (typeof fromMetadata === "string") {
    return fromMetadata as ToolCallId;
  }
  return `synth-${crypto.randomUUID()}` as ToolCallId;
}
