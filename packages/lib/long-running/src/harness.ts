/**
 * createLongRunningHarness — multi-turn agent lifecycle coordinator.
 *
 * Wraps the existing engine loop with:
 *  - Lifecycle state machine (idle → active → suspended/completed/failed).
 *  - SessionLease (in-memory WeakSet capability) for at-most-once durable
 *    transitions in a single process.
 *  - Soft checkpoints driven by `afterTurn` middleware.
 *  - Quiesce-before-publish for terminal phases.
 *
 * No new L0 contracts: depends only on existing SessionPersistence,
 * HarnessSnapshotStore, and EngineAdapter saveState/loadState.
 */

import type {
  ChainId,
  ContextSummary,
  EngineInput,
  EngineState,
  HarnessPhase,
  HarnessSnapshot,
  HarnessStatus,
  KeyArtifact,
  KoiError,
  KoiMiddleware,
  NodeId,
  Result,
  SessionId,
  SessionRecord,
  SnapshotNode,
  Task,
  TaskResult,
} from "@koi/core";
import { chainId as toChainId, sessionId as toSessionId } from "@koi/core";

import { createCheckpointMiddleware } from "./checkpoint-middleware.js";
import { shouldSoftCheckpoint } from "./checkpoint-policy.js";
import { buildHarnessSnapshot, EMPTY_TASK_BOARD, ZERO_METRICS } from "./snapshot-builder.js";
import {
  type CheckpointMiddlewareConfig,
  DEFAULT_LONG_RUNNING_CONFIG,
  type LongRunningConfig,
  type LongRunningHarness,
  type SessionLease,
  type StartResult,
} from "./types.js";

interface MutableState {
  phase: HarnessPhase;
  sessionSeq: number;
  startedAt: number;
  checkpointedAt: number;
  failureReason: string | undefined;
  summaries: readonly ContextSummary[];
  keyArtifacts: readonly KeyArtifact[];
  metrics: HarnessSnapshot["metrics"];
  taskBoard: HarnessSnapshot["taskBoard"];
  lastNodeId: NodeId | undefined;
  lastSessionId: string | undefined;
  turnCount: number;
  inTurn: boolean;
  terminating: boolean;
  // Effective task-retry budget for this harness instance. Persisted in
  // snapshot node metadata so resumed sessions cannot silently change
  // retry semantics across deploys/restarts.
  effectiveTaskMaxRetries: number;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  lease: SessionLease | undefined;
  abortController: AbortController | undefined;
}

const err = (
  code: KoiError["code"],
  message: string,
  retryable: boolean,
  context?: KoiError["context"],
): KoiError => ({ code, message, retryable, ...(context !== undefined && { context }) });

function validateConfig(cfg: LongRunningConfig): KoiError | undefined {
  if (!cfg.harnessId) return err("VALIDATION", "harnessId required", false);
  if (!cfg.agentId) return err("VALIDATION", "agentId required", false);
  if (!cfg.harnessStore) return err("VALIDATION", "harnessStore required", false);
  if (!cfg.sessionPersistence) return err("VALIDATION", "sessionPersistence required", false);
  if (cfg.softCheckpointInterval !== undefined && cfg.softCheckpointInterval <= 0) {
    return err("VALIDATION", "softCheckpointInterval must be > 0", false);
  }
  if (cfg.timeoutMs !== undefined && cfg.timeoutMs <= 0) {
    return err("VALIDATION", "timeoutMs must be > 0", false);
  }
  if (cfg.taskMaxRetries !== undefined) {
    const v = cfg.taskMaxRetries;
    if (!Number.isInteger(v) || v < 0) {
      return err("VALIDATION", "taskMaxRetries must be a non-negative integer", false, {
        taskMaxRetries: v,
      });
    }
  }
  // Fail-fast on the saveState contract: pause() requires durable
  // engine-state capture, and the harness has no transcript replay
  // path. Reject at construction so consumers cannot build a harness
  // that will silently fail on the first suspend attempt.
  if (typeof cfg.saveState !== "function") {
    return err(
      "VALIDATION",
      "saveState is required: pause() needs durable engine-state capture and the harness has no transcript-replay fallback",
      false,
    );
  }
  return undefined;
}

function isStartable(phase: HarnessPhase | undefined): boolean {
  return phase === undefined || phase === "idle" || phase === "completed" || phase === "failed";
}

export function createLongRunningHarness(
  cfg: LongRunningConfig,
): Result<LongRunningHarness, KoiError> {
  const validationError = validateConfig(cfg);
  if (validationError) return { ok: false, error: validationError };

  const now = cfg.now ?? Date.now;
  const interval = cfg.softCheckpointInterval ?? DEFAULT_LONG_RUNNING_CONFIG.softCheckpointInterval;
  const abortTimeoutMs = cfg.abortTimeoutMs ?? DEFAULT_LONG_RUNNING_CONFIG.abortTimeoutMs;
  const pruning = cfg.pruningPolicy ?? DEFAULT_LONG_RUNNING_CONFIG.pruningPolicy;
  const chain: ChainId = toChainId(cfg.harnessId);

  const activeLeases = new WeakSet<SessionLease>();
  let epochCounter = 0;

  // Lifecycle mutex — every mutating call serializes through this chain so
  // concurrent pause/completeTask/start/etc. observe a consistent view of
  // state.taskBoard, state.summaries, state.metrics, and lease identity.
  let mutationChain: Promise<unknown> = Promise.resolve();
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = mutationChain.then(fn, fn);
    mutationChain = next.catch(() => undefined);
    return next;
  };

  const state: MutableState = {
    phase: "idle",
    sessionSeq: 0,
    startedAt: 0,
    checkpointedAt: 0,
    failureReason: undefined,
    summaries: [],
    keyArtifacts: [],
    metrics: ZERO_METRICS,
    taskBoard: EMPTY_TASK_BOARD,
    lastNodeId: undefined,
    lastSessionId: undefined,
    turnCount: 0,
    inTurn: false,
    terminating: false,
    effectiveTaskMaxRetries: cfg.taskMaxRetries ?? 3,
    timeoutHandle: undefined,
    lease: undefined,
    abortController: undefined,
  };

  interface StateDelta {
    readonly taskBoard?: HarnessSnapshot["taskBoard"];
    readonly summaries?: readonly ContextSummary[];
    readonly keyArtifacts?: readonly KeyArtifact[];
    readonly metrics?: HarnessSnapshot["metrics"];
  }

  const buildSnapshot = (
    phase: HarnessPhase,
    failureReason?: string,
    delta: StateDelta = {},
  ): HarnessSnapshot =>
    buildHarnessSnapshot({
      harnessId: cfg.harnessId,
      agentId: cfg.agentId,
      phase,
      sessionSeq: state.sessionSeq,
      taskBoard: delta.taskBoard ?? state.taskBoard,
      summaries: delta.summaries ?? state.summaries,
      keyArtifacts: delta.keyArtifacts ?? state.keyArtifacts,
      metrics: delta.metrics ?? state.metrics,
      startedAt: state.startedAt,
      checkpointedAt: now(),
      lastSessionId: state.lastSessionId,
      failureReason: failureReason ?? state.failureReason,
    });

  const putSnapshot = async (
    snapshot: HarnessSnapshot,
  ): Promise<Result<SnapshotNode<HarnessSnapshot>, KoiError>> => {
    const parents: readonly NodeId[] = state.lastNodeId ? [state.lastNodeId] : [];
    const result = await cfg.harnessStore.put(chain, snapshot, parents, {
      reason: snapshot.phase,
      taskMaxRetries: state.effectiveTaskMaxRetries,
    });
    if (!result.ok) return { ok: false, error: result.error };
    if (!result.value) {
      return {
        ok: false,
        error: err("INTERNAL", "harnessStore.put returned undefined node", false),
      };
    }
    state.lastNodeId = result.value.nodeId;
    state.checkpointedAt = result.value.createdAt;
    return { ok: true, value: result.value };
  };

  const loadHead = async (): Promise<Result<SnapshotNode<HarnessSnapshot> | undefined, KoiError>> =>
    cfg.harnessStore.head(chain);

  const adoptHead = (node: SnapshotNode<HarnessSnapshot>): void => {
    const data = node.data;
    state.phase = data.phase;
    state.sessionSeq = data.sessionSeq;
    state.startedAt = data.startedAt;
    state.checkpointedAt = data.checkpointedAt;
    state.failureReason = data.failureReason;
    state.summaries = data.summaries;
    state.keyArtifacts = data.keyArtifacts;
    state.metrics = data.metrics;
    state.taskBoard = data.taskBoard;
    state.lastSessionId = data.lastSessionId;
    state.lastNodeId = node.nodeId;
    // Restore the persisted retry budget so a resumed harness keeps the
    // semantics it had at the time of suspend, regardless of the local
    // cfg.taskMaxRetries the host happens to pass at resume time.
    const persisted = node.metadata.taskMaxRetries;
    if (typeof persisted === "number" && Number.isInteger(persisted) && persisted >= 0) {
      state.effectiveTaskMaxRetries = persisted;
    }
  };

  const mintLease = (sid: SessionId): SessionLease => {
    const ac = new AbortController();
    state.abortController = ac;
    const lease: SessionLease = {
      sessionId: sid,
      epoch: epochCounter++,
      abort: ac.signal,
    };
    activeLeases.add(lease);
    state.lease = lease;
    return lease;
  };

  const revokeLease = (): void => {
    if (state.lease) {
      activeLeases.delete(state.lease);
      captureCache.delete(state.lease);
    }
    state.abortController?.abort();
    state.lease = undefined;
    state.abortController = undefined;
  };

  const verifyLease = (lease: SessionLease): KoiError | undefined =>
    activeLeases.has(lease) ? undefined : err("STALE_REF", "lease revoked or unknown", false);

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const quiesce = async (deadlineMs: number): Promise<boolean> => {
    const start = now();
    // Single absolute deadline across both stages so total wall-clock
    // wait never exceeds `abortTimeoutMs`. When `quiesceEngine` is
    // wired, cap the inTurn polling at half the budget so the
    // callback always gets a real chance to acknowledge drain.
    // First-stage poll: cap at half the deadline when quiesceEngine
    // is wired so the callback gets a real chance to acknowledge drain.
    const pollBudget = cfg.quiesceEngine ? Math.floor(deadlineMs / 2) : deadlineMs;
    while (state.inTurn && now() - start < pollBudget) {
      await sleep(10);
    }
    const turnCleared = !state.inTurn;
    // Two-stage drain:
    //  1. Turn flag must clear naturally (onAfterTurn fired) — proof
    //     the current turn finished mutating in-memory state.
    //  2. If a host `quiesceEngine` is wired, it must also resolve —
    //     proof that async tool/MCP/stream work has drained.
    // If the turn flag never cleared, fall back to `quiesceEngine` as
    // a wedge-override (for the stale-inTurn case where the turn
    // errored after onBeforeTurn). The host contract documented in
    // types.ts requires the callback to confirm turn completion in
    // that mode — without quiesceEngine wired we just fail.
    if (cfg.quiesceEngine) {
      const remaining = Math.max(0, deadlineMs - (now() - start));
      // Lease-bound drain: pass the current session/lease so the host
      // callback can scope verification to this exact execution. If
      // the lease has already been revoked (no current owner), there
      // is nothing to drain — accept turnCleared as the answer.
      const lease = state.lease;
      const sessionId = state.lastSessionId ? toSessionId(state.lastSessionId) : undefined;
      if (!lease || !sessionId) return turnCleared;
      let callbackOk = false;
      try {
        await Promise.race([
          cfg.quiesceEngine({ sessionId, lease }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("quiesceEngine deadline")), remaining),
          ),
        ]);
        callbackOk = true;
      } catch {
        return false;
      }
      // Normal path: require BOTH the turn flag cleared AND the host
      // callback to confirm drain. A callback resolving fast does NOT
      // license bypassing onAfterTurn bookkeeping (turn counters,
      // metrics, soft-checkpoint side effects).
      if (turnCleared) return callbackOk;
      // Stuck-middleware override: only after the FULL deadline has
      // elapsed with inTurn still true do we accept the callback as
      // sole proof. A turn legitimately taking >50% of the timeout to
      // unwind is not stuck — it's slow. We re-check inTurn here in
      // case onAfterTurn fired during the callback wait.
      if (!state.inTurn) return callbackOk;
      const fullyTimedOut = now() - start >= deadlineMs;
      if (fullyTimedOut && callbackOk) return true;
      return false;
    }
    // No host drain callback wired: rely solely on the middleware
    // turn flag. If it never cleared, return false — the caller can
    // retry, and a future onAfterTurn or onTurnStart will eventually
    // unblock the transition. Do NOT force-clear inTurn here.
    return turnCleared;
  };

  const clearTimer = (): void => {
    if (state.timeoutHandle) {
      clearTimeout(state.timeoutHandle);
      state.timeoutHandle = undefined;
    }
  };

  const persistSessionStatus = async (
    sid: SessionId,
    status: SessionRecord["status"],
  ): Promise<void> => {
    // Best-effort with one retry on Err/exception. The snapshot chain is
    // the durable source of truth — callers reconciling crash candidates
    // should treat the snapshot phase as authoritative when it disagrees
    // with SessionRecord.status. Persistent failure is annotated on
    // state.failureReason so getStatus() surfaces the divergence.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await cfg.sessionPersistence.setSessionStatus(sid, status);
        if (r.ok) return;
      } catch {
        // fall through to retry
      }
    }
    const note = `session status update to "${status}" failed after retry`;
    state.failureReason = state.failureReason ? `${state.failureReason}; ${note}` : note;
  };

  const buildEngineInput = (signal: AbortSignal, st?: EngineState | undefined): EngineInput =>
    st ? { kind: "resume", state: st, signal } : { kind: "text", text: "", signal };

  const activate = async (expect: "start" | "resume"): Promise<Result<StartResult, KoiError>> => {
    const headRes = await loadHead();
    if (!headRes.ok) return { ok: false, error: headRes.error };
    const head = headRes.value;

    if (expect === "start") {
      if (head && !isStartable(head.data.phase)) {
        return {
          ok: false,
          error: err("CONFLICT", `cannot start: head phase is ${head.data.phase}`, true),
        };
      }
    } else {
      if (!head) {
        return { ok: false, error: err("NOT_FOUND", "no harness snapshot to resume", false) };
      }
      // `suspended` is always resumable. `active` is resumable only
      // when the host opts in via `allowActiveResume` (which signals
      // they enforce durable ownership fencing externally) — without
      // fencing, active resume risks split-brain with a slow or
      // partitioned prior worker. Migration path for crashed-active
      // heads created under older versions: the host must either
      // (a) set `allowActiveResume: true` after confirming the prior
      // worker is dead via heartbeat/CAS, or (b) write a `failed`
      // snapshot directly to the store to mark the head non-resumable
      // and start a fresh run via start().
      const isResumablePhase =
        head.data.phase === "suspended" ||
        (head.data.phase === "active" && cfg.allowActiveResume === true);
      if (!isResumablePhase) {
        return {
          ok: false,
          error: err(
            "CONFLICT",
            head.data.phase === "active"
              ? 'cannot resume: head phase is "active" — set allowActiveResume after confirming the prior worker is dead via external ownership fencing, or publish a failed snapshot and call start()'
              : `cannot resume: head phase is "${head.data.phase}" (only "suspended" and (with allowActiveResume) "active" are resumable)`,
            false,
            { phase: head.data.phase },
          ),
        };
      }
    }

    if (head) adoptHead(head);
    if (expect === "start" || state.startedAt === 0) state.startedAt = now();
    state.sessionSeq += 1;
    state.failureReason = undefined;
    // Clear any leftover terminating flag from a prior session — soft
    // checkpoints in this new session must be allowed to fire.
    state.terminating = false;
    // Fresh start re-initializes the retry budget from current config so
    // operators can tighten/relax policy across runs. Resume preserves
    // the persisted value adopted from the head snapshot.
    if (expect === "start") {
      state.effectiveTaskMaxRetries = cfg.taskMaxRetries ?? 3;
    }

    // Resume requires durable engine state on the prior session row.
    // Persistence read errors propagate verbatim (transient faults
    // keep `retryable=true`; missing rows surface as NOT_FOUND). A
    // suspended head whose prior session row is missing
    // `lastEngineState` (e.g. legacy snapshots written before
    // saveState was required) is rejected as NOT_FOUND — the harness
    // has no transcript-replay path and silently restarting from an
    // empty prompt would risk duplicate side effects and lost progress.
    let carriedState: EngineState | undefined;
    let priorSessionId: string | undefined;
    if (expect === "resume") {
      if (!head?.data.lastSessionId) {
        return {
          ok: false,
          error: err("NOT_FOUND", "cannot resume: head snapshot has no prior session id", false),
        };
      }
      priorSessionId = head.data.lastSessionId;
      const priorRes = await cfg.sessionPersistence.loadSession(priorSessionId);
      if (!priorRes.ok) return { ok: false, error: priorRes.error };
      carriedState = priorRes.value.lastEngineState;
      if (carriedState === undefined) {
        // Compatibility hook for legacy suspended heads that pre-date
        // the saveState requirement. Distinguish three cases:
        //   - hook absent → permanent NOT_FOUND (no fallback wired)
        //   - hook threw → retryable EXTERNAL (don't strand resumable
        //     runs on transient replay-dependency faults)
        //   - hook returned undefined → permanent NOT_FOUND (no replay
        //     state exists for this session)
        if (cfg.legacyResumeFallback) {
          try {
            const fallback = (await cfg.legacyResumeFallback(priorSessionId)) as
              | EngineState
              | undefined;
            if (fallback !== undefined) carriedState = fallback;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
              ok: false,
              error: err("EXTERNAL", `legacyResumeFallback threw: ${msg}`, true, {
                priorSessionId,
              }),
            };
          }
        }
        if (carriedState === undefined) {
          return {
            ok: false,
            error: err(
              "NOT_FOUND",
              cfg.legacyResumeFallback
                ? "cannot resume: legacyResumeFallback returned no state for prior session"
                : "cannot resume: prior session has no lastEngineState and no legacyResumeFallback was supplied",
              false,
              { priorSessionId },
            ),
          };
        }
      }
    }

    const sid: SessionId = toSessionId(crypto.randomUUID());
    state.lastSessionId = sid;
    const lease = mintLease(sid);

    const sessionRec: SessionRecord = {
      sessionId: sid,
      agentId: cfg.agentId,
      manifestSnapshot: {
        name: cfg.agentId,
        version: "0",
        instructions: "",
      } as unknown as SessionRecord["manifestSnapshot"],
      seq: 0,
      remoteSeq: 0,
      connectedAt: now(),
      lastPersistedAt: now(),
      ...(carriedState !== undefined && { lastEngineState: carriedState }),
      status: "running",
      metadata: {},
    };
    const saveRes = await cfg.sessionPersistence.saveSession(sessionRec);
    if (!saveRes.ok) {
      revokeLease();
      return { ok: false, error: saveRes.error };
    }

    const snapshot = buildSnapshot("active");
    const putRes = await putSnapshot(snapshot);
    if (!putRes.ok) {
      revokeLease();
      await cfg.sessionPersistence.removeSession(sid);
      return { ok: false, error: putRes.error };
    }
    // Only after the new active snapshot is durable do we tombstone the
    // superseded prior session. Reordering this AFTER putSnapshot ensures
    // that if snapshot publication fails we don't leave the snapshot
    // store pointing at the prior suspended head while the session store
    // says that session is permanently `done`. Best-effort: failure here
    // is non-fatal (annotated into failureReason via persistSessionStatus).
    if (priorSessionId !== undefined) {
      await persistSessionStatus(toSessionId(priorSessionId), "done");
    }
    state.phase = "active";
    state.turnCount = 0;

    if (cfg.timeoutMs !== undefined) {
      state.timeoutHandle = setTimeout(() => {
        // Route through the lifecycle mutex so timeout cannot race a
        // concurrent pause/fail/completeTask transition.
        void withLock(() => publishTerminal("failed", "TIMEOUT"));
      }, cfg.timeoutMs);
    }

    return {
      ok: true,
      value: {
        lease,
        engineInput: buildEngineInput(lease.abort, carriedState),
        sessionId: sid,
      },
    };
  };

  // Capture variants:
  //  - skip: saveState not configured (best-effort path; never an error)
  //  - error: saveState threw or persistence failed; suspend MUST treat
  //    this as fatal to avoid publishing an unresumable suspended head.
  //    Soft-checkpoint and other terminal targets may still proceed.
  //  - value: captured payload to write into the session row
  type CapturedEngineState =
    | { readonly kind: "skip" }
    | { readonly kind: "error"; readonly error: KoiError }
    | { readonly kind: "value"; readonly value: EngineState | undefined };

  // Cache of pre-abort engine-state captures keyed by lease. If a
  // pause() attempt fails after capture+abort and the caller retries,
  // the second attempt reuses the original capture instead of asking a
  // post-abort engine for fresh state (which may be cleared/invalidated
  // and would overwrite the only good lastEngineState on the session
  // row). Cleared by revokeLease() on every terminal transition.
  const captureCache = new WeakMap<SessionLease, CapturedEngineState>();

  const captureEngineState = async (): Promise<CapturedEngineState> => {
    if (!cfg.saveState) return { kind: "skip" };
    try {
      const value = (await cfg.saveState()) as EngineState | undefined;
      return { kind: "value", value };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        kind: "error",
        error: err("EXTERNAL", `saveState threw: ${msg}`, true),
      };
    }
  };

  const writeCapturedEngineState = async (
    captured: CapturedEngineState,
    targetSessionId: string,
  ): Promise<Result<void, KoiError>> => {
    // Bind the write to the session id captured at transition entry.
    // If a concurrent activate() has already advanced state.lastSessionId
    // to a fresh session, do NOT cross-contaminate by writing this
    // captured state into the new session row.
    if (captured.kind !== "value" || state.lastSessionId !== targetSessionId) {
      return { ok: true, value: undefined };
    }
    try {
      const sid = toSessionId(targetSessionId);
      const loadRes = await cfg.sessionPersistence.loadSession(sid);
      if (!loadRes.ok) return { ok: false, error: loadRes.error };
      const saveRes = await cfg.sessionPersistence.saveSession({
        ...loadRes.value,
        lastEngineState: captured.value,
        lastPersistedAt: now(),
      });
      if (!saveRes.ok) return { ok: false, error: saveRes.error };
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: err("EXTERNAL", `engine state write threw: ${msg}`, true) };
    }
  };

  const commitDelta = (delta: StateDelta): void => {
    if (delta.taskBoard !== undefined) state.taskBoard = delta.taskBoard;
    if (delta.summaries !== undefined) state.summaries = delta.summaries;
    if (delta.keyArtifacts !== undefined) state.keyArtifacts = delta.keyArtifacts;
    if (delta.metrics !== undefined) state.metrics = delta.metrics;
  };

  const publishTerminal = async (
    target: "suspended" | "completed" | "failed",
    failureReason?: string,
    buildDelta: () => StateDelta = () => ({}),
  ): Promise<Result<void, KoiError>> => {
    if (state.phase !== "active") return { ok: true, value: undefined };
    state.terminating = true;
    clearTimer();
    const sidAtEntry = state.lastSessionId;
    // For "suspended", capture resumable engine state BEFORE firing abort
    // — a cooperative engine may clear state on abort, and we need to be
    // able to resume from the live execution point. On retry of a
    // failed pause, reuse the cached capture from the first attempt so
    // we don't ask a post-abort engine for stale/empty state.
    const cachedCapture =
      target === "suspended" && state.lease ? captureCache.get(state.lease) : undefined;
    const captured: CapturedEngineState =
      target === "suspended" ? (cachedCapture ?? (await captureEngineState())) : { kind: "skip" };
    // Suspend MUST treat capture failure as fatal — publishing a
    // suspended snapshot whose prior session has no resumable state
    // produces a silently-broken resume. Bail before abort so the
    // active lease stays usable for retry / fail / dispose.
    if (target === "suspended" && captured.kind === "error") {
      state.terminating = false;
      return { ok: false, error: captured.error };
    }
    // Fire abort so the engine stops emitting side effects. DO NOT revoke
    // the lease (and do NOT commit the speculative delta) until the
    // terminal snapshot is durably published. On quiesce timeout or store
    // failure, the caller can retry the same transition with the same
    // lease and the same delta — applying it twice is impossible because
    // state mutation is gated on success.
    state.abortController?.abort();
    const quiet = await quiesce(abortTimeoutMs);
    if (!quiet) {
      state.terminating = false;
      // Do NOT memoize the capture: if quiesce timed out, the engine
      // is still executing and may advance further before the caller
      // retries. A retry must recapture from the actual stopped state
      // so the persisted lastEngineState matches the durable snapshot.
      return {
        ok: false,
        error: err("TIMEOUT", "engine did not quiesce within abortTimeoutMs", true, {
          abortTimeoutMs,
        }),
      };
    }
    // Engine has quiesced — only NOW is the captured state guaranteed
    // to correspond to a stopped engine. Memoize so a snapshot-publish
    // retry on the same lease reuses it instead of asking a
    // post-abort engine for fresh (possibly cleared) state. Only
    // memoize successful captures: a transient saveState() throw
    // (kind=error) must allow the next pause to recapture.
    if (
      target === "suspended" &&
      state.lease &&
      !cachedCapture &&
      (captured.kind === "value" || captured.kind === "skip")
    ) {
      captureCache.set(state.lease, captured);
    }
    // Build the delta AFTER quiesce so any metrics/summaries advanced by a
    // late onTurnEnd are merged in, not silently overwritten.
    const delta = buildDelta();
    let effectiveReason = failureReason;
    // For SUSPENDED targets: write engine state to the session row BEFORE
    // publishing the suspended snapshot. This ordering ensures that a
    // durable suspended head ALWAYS has a corresponding lastEngineState
    // — there is no window in which the snapshot store advertises a
    // resumable suspend with no engine state behind it. If the write
    // fails we never publish suspended; the caller retains the lease
    // and can retry / fail / dispose.
    if (target === "suspended" && sidAtEntry !== undefined) {
      const writeRes = await writeCapturedEngineState(captured, sidAtEntry);
      if (!writeRes.ok) {
        state.terminating = false;
        return { ok: false, error: writeRes.error };
      }
    }
    const snapshot = buildSnapshot(target, effectiveReason, delta);
    const putRes = await putSnapshot(snapshot);
    if (!putRes.ok) {
      const headRes = await loadHead();
      if (headRes.ok && headRes.value) state.lastNodeId = headRes.value.nodeId;
      const retry = await putSnapshot(buildSnapshot(target, effectiveReason, delta));
      if (!retry.ok) {
        state.terminating = false;
        return { ok: false, error: retry.error };
      }
    }
    // For non-suspended terminals the engine-state write is best-effort:
    // a failure annotates failureReason for observability but the
    // already-published terminal snapshot stands.
    const effectiveTarget: typeof target = target;
    if (target !== "suspended" && sidAtEntry !== undefined) {
      const writeRes = await writeCapturedEngineState(captured, sidAtEntry);
      if (!writeRes.ok) {
        const note = `engine-state-write: ${writeRes.error.message}`;
        effectiveReason = effectiveReason ? `${effectiveReason}; ${note}` : note;
      }
    }
    commitDelta(delta);
    revokeLease();
    state.phase = effectiveTarget;
    state.failureReason = effectiveReason;
    if (state.lastSessionId) {
      const sid = toSessionId(state.lastSessionId);
      const failureBefore = state.failureReason;
      await persistSessionStatus(sid, effectiveTarget === "suspended" ? "idle" : "done");
      // If persistSessionStatus exhausted retries it appended a note to
      // state.failureReason. Persist that durably with a follow-up
      // snapshot so the divergence survives a process restart and is
      // visible to operators / recovery logic via adoptHead().
      if (state.failureReason !== failureBefore) {
        const annotated = buildSnapshot(effectiveTarget, state.failureReason, delta);
        await putSnapshot(annotated);
      }
    }
    // Post-commit work is best-effort: the terminal snapshot is already
    // durable and the lease is revoked. A throw/reject here MUST NOT
    // signal failure to the caller — that would encourage retries against
    // already-committed state. Capture failures into failureReason so
    // they remain observable via getStatus().
    const postCommitBefore = state.failureReason;
    const noteFailure = (label: string, e: unknown): void => {
      const msg = e instanceof Error ? e.message : String(e);
      const note = `${label}: ${msg}`;
      state.failureReason = state.failureReason ? `${state.failureReason}; ${note}` : note;
    };
    try {
      const pruneRes = await cfg.harnessStore.prune(chain, pruning);
      if (!pruneRes.ok) noteFailure("prune", pruneRes.error.message);
    } catch (e: unknown) {
      noteFailure("prune", e);
    }
    if (effectiveTarget === "completed" && cfg.onCompleted) {
      try {
        await cfg.onCompleted(getStatus());
      } catch (e: unknown) {
        noteFailure("onCompleted", e);
      }
    }
    if (effectiveTarget === "failed" && cfg.onFailed) {
      try {
        await cfg.onFailed(
          getStatus(),
          err("INTERNAL", effectiveReason ?? "harness failed", false),
        );
      } catch (e: unknown) {
        noteFailure("onFailed", e);
      }
    }
    // Persist post-commit failure annotations durably so they survive a
    // process restart and are visible to operators via adoptHead(). Best-
    // effort: a snapshot-write failure here is itself appended to the
    // failure reason but not surfaced to the caller (the original
    // terminal transition already committed successfully).
    if (state.failureReason !== postCommitBefore) {
      try {
        const annotated = buildSnapshot(effectiveTarget, state.failureReason, delta);
        const annRes = await putSnapshot(annotated);
        if (!annRes.ok) {
          state.failureReason = `${state.failureReason}; annotate: ${annRes.error.message}`;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        state.failureReason = `${state.failureReason}; annotate: ${msg}`;
      }
    }
    return { ok: true, value: undefined };
  };

  const softCheckpoint = async (delta: StateDelta = {}): Promise<Result<void, KoiError>> => {
    if (state.phase !== "active") return { ok: true, value: undefined };
    if (state.terminating) return { ok: true, value: undefined };
    const sidAtEntry = state.lastSessionId;
    // Capture before put so the engine state matches the snapshot we're
    // about to publish. A capture error MUST fail the checkpoint:
    // advancing the snapshot head past unrecoverable state would let
    // a later resume() find a head whose engine state is older than
    // the snapshot chain implies.
    const captured = await captureEngineState();
    if (captured.kind === "error") return { ok: false, error: captured.error };
    // Persist engine state BEFORE publishing the snapshot so the
    // session row's lastEngineState always matches (or post-dates) the
    // active head.
    if (sidAtEntry !== undefined) {
      const writeRes = await writeCapturedEngineState(captured, sidAtEntry);
      if (!writeRes.ok) return { ok: false, error: writeRes.error };
    }
    const snapshot = buildSnapshot("active", undefined, delta);
    const putRes = await putSnapshot(snapshot);
    if (!putRes.ok) return { ok: false, error: putRes.error };
    commitDelta(delta);
    return { ok: true, value: undefined };
  };

  const buildSessionResultDelta = (sessionResult: {
    readonly summary: HarnessSnapshot["summaries"][number];
    readonly newKeyArtifacts: HarnessSnapshot["keyArtifacts"];
    readonly metricsDelta: Partial<HarnessSnapshot["metrics"]>;
  }): StateDelta => {
    const summaries = [...state.summaries, sessionResult.summary];
    const cap = cfg.maxKeyArtifacts ?? DEFAULT_LONG_RUNNING_CONFIG.maxKeyArtifacts;
    const merged = [...state.keyArtifacts, ...sessionResult.newKeyArtifacts];
    const keyArtifacts = merged.length > cap ? merged.slice(merged.length - cap) : merged;
    const metrics = { ...state.metrics, ...sessionResult.metricsDelta };
    return { summaries, keyArtifacts, metrics };
  };

  const buildTaskUpdateDelta = (
    taskId: string,
    nextStatus: "completed" | "failed",
    result: unknown,
    error?: KoiError,
  ): {
    readonly delta: StateDelta;
    readonly found: boolean;
    readonly remaining: number;
  } => {
    let found = false;
    let foundStartedAt: number | undefined;
    const tNow = now();
    const items = state.taskBoard.items.map((t: Task) => {
      // L0 task-board contract: only `in_progress` may transition to
      // `completed` / `failed`. A `pending` task must first be started.
      // Reject stale/out-of-order callbacks for `pending` tasks here so
      // we never short-circuit `remaining === 0` from an unstarted task.
      if (t.id === taskId && t.status === "in_progress") {
        found = true;
        foundStartedAt = t.startedAt;
        // Mirror the L0 terminal-transition rules: clear transient
        // `activeForm`, bump `version`, set `updatedAt`.
        const next: Task = {
          ...t,
          status: nextStatus,
          activeForm: undefined,
          version: t.version + 1,
          updatedAt: tNow,
          ...(error !== undefined && { error }),
        };
        return next;
      }
      return t;
    });
    const safeStringify = (v: unknown): string => {
      if (typeof v === "string") return v;
      if (v === undefined || v === null) return "null";
      try {
        return JSON.stringify(v) ?? "null";
      } catch {
        return "[unserializable]";
      }
    };
    // Preserve structured TaskResult fields when the caller passes a
    // result object conforming to the TaskResult shape. Each optional
    // field is validated to be JSON-safe before passthrough — the
    // snapshot store serializes via JSON.stringify, and a non-JSON-safe
    // payload must not be allowed to brick durable snapshot writes.
    const isJsonSafe = (v: unknown): boolean => {
      try {
        JSON.stringify(v);
        return true;
      } catch {
        return false;
      }
    };
    const clampDuration = (n: number, fallback: number): number =>
      Number.isFinite(n) && n >= 0 ? n : fallback;
    const buildResult = (v: unknown): TaskResult => {
      const fallbackDuration =
        foundStartedAt !== undefined ? Math.max(0, tNow - foundStartedAt) : 0;
      if (v !== null && typeof v === "object") {
        const r = v as Partial<TaskResult> & Record<string, unknown>;
        const hasOutput = typeof r.output === "string";
        const hasDuration = typeof r.durationMs === "number";
        if (hasOutput || hasDuration) {
          const base: TaskResult = {
            taskId: taskId as Task["id"],
            output: hasOutput ? (r.output as string) : safeStringify(v),
            durationMs: hasDuration
              ? clampDuration(r.durationMs as number, fallbackDuration)
              : fallbackDuration,
          };
          // Pass-through optional structured fields only if they are
          // JSON-safe. Anything cyclic or otherwise non-serializable is
          // dropped — better to lose the field than corrupt the snapshot.
          const extras: Partial<TaskResult> = {};
          if (r.results !== undefined && isJsonSafe(r.results)) {
            (extras as Record<string, unknown>).results = r.results;
          }
          if (Array.isArray(r.artifacts) && isJsonSafe(r.artifacts)) {
            (extras as Record<string, unknown>).artifacts = r.artifacts;
          }
          if (Array.isArray(r.decisions) && isJsonSafe(r.decisions)) {
            (extras as Record<string, unknown>).decisions = r.decisions;
          }
          if (Array.isArray(r.warnings) && r.warnings.every((w) => typeof w === "string")) {
            (extras as Record<string, unknown>).warnings = r.warnings;
          }
          if (r.metadata !== undefined && isJsonSafe(r.metadata)) {
            (extras as Record<string, unknown>).metadata = r.metadata;
          }
          return { ...base, ...extras };
        }
      }
      return {
        taskId: taskId as Task["id"],
        output: safeStringify(v),
        durationMs: fallbackDuration,
      };
    };
    const results =
      found && nextStatus === "completed"
        ? [...state.taskBoard.results, buildResult(result)]
        : state.taskBoard.results;
    const taskBoard = { items, results };
    const remaining = items.filter(
      (t: Task) => t.status === "pending" || t.status === "in_progress",
    ).length;
    return { delta: { taskBoard }, found, remaining };
  };

  // Terminal fail transition with full task-board cleanup: clears
  // assignedTo and backfills lastAssignedTo from assignedTo when the
  // legacy field is missing. Used for retry-exhaustion and non-retryable
  // failure paths so the persisted snapshot stays consistent with
  // task-board ACL/orphan invariants.
  const buildTerminalFailDelta = (
    taskId: string,
    error: KoiError,
  ): { readonly delta: StateDelta; readonly found: boolean } => {
    let found = false;
    const tNow = now();
    const items = state.taskBoard.items.map((t: Task) => {
      if (t.id === taskId && t.status === "in_progress") {
        found = true;
        const lastAssigned = t.lastAssignedTo !== undefined ? t.lastAssignedTo : t.assignedTo;
        const next: Task = {
          ...t,
          status: "failed",
          activeForm: undefined,
          assignedTo: undefined,
          ...(lastAssigned !== undefined && { lastAssignedTo: lastAssigned }),
          version: t.version + 1,
          updatedAt: tNow,
          error,
        };
        return next;
      }
      return t;
    });
    return { delta: { taskBoard: { items, results: state.taskBoard.results } }, found };
  };

  const onTurnStart = (): void => {
    // Self-heal: a new turn starting is proof the engine drained the
    // previous one and is making progress. If a prior turn errored
    // after onBeforeTurn but before onAfterTurn, inTurn would still
    // be true here — re-asserting it (rather than the terminal path
    // force-clearing) means quiesce stays correct: we only return
    // success when an actual onAfterTurn (or quiesceEngine) confirms.
    state.inTurn = true;
  };
  const onTurnEnd = async (): Promise<void> => {
    state.turnCount += 1;
    state.metrics = { ...state.metrics, totalTurns: state.metrics.totalTurns + 1 };
    try {
      if (shouldSoftCheckpoint(state.turnCount, interval)) {
        const res = await softCheckpoint();
        if (!res.ok) {
          // Checkpoint persistence failed. Surface the failure into
          // failureReason and abort the active lease so the engine
          // stops emitting side effects. Operators see the divergence
          // via getStatus(); the next mutation API call will observe
          // phase=active but the lease is already aborted, so the
          // caller can transition to fail()/dispose() cleanly.
          const note = `softCheckpoint: ${res.error.message}`;
          state.failureReason = state.failureReason ? `${state.failureReason}; ${note}` : note;
          state.abortController?.abort();
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const note = `softCheckpoint: ${msg}`;
      state.failureReason = state.failureReason ? `${state.failureReason}; ${note}` : note;
      state.abortController?.abort();
    } finally {
      // Always clear inTurn — even on checkpoint error/throw — so quiesce
      // can drain. Otherwise a transient store fault would wedge every
      // subsequent terminal transition.
      state.inTurn = false;
    }
  };

  const getStatus = (): HarnessStatus => ({
    harnessId: cfg.harnessId,
    phase: state.phase,
    currentSessionSeq: state.sessionSeq,
    taskBoard: state.taskBoard,
    metrics: state.metrics,
    lastSessionEndedAt: state.checkpointedAt || undefined,
    startedAt: state.startedAt || undefined,
    failureReason: state.failureReason,
  });

  const harness: LongRunningHarness = {
    start: () => withLock(() => activate("start")),
    resume: () => withLock(() => activate("resume")),
    pause: (lease, sessionResult) =>
      withLock(async (): Promise<Result<void, KoiError>> => {
        const e = verifyLease(lease);
        if (e) return { ok: false, error: e };
        return publishTerminal("suspended", undefined, () =>
          buildSessionResultDelta(sessionResult),
        );
      }),
    fail: (lease, error) =>
      withLock(async (): Promise<Result<void, KoiError>> => {
        const e = verifyLease(lease);
        if (e) return { ok: false, error: e };
        return publishTerminal("failed", error.message);
      }),
    completeTask: (lease, taskId, result) =>
      withLock(async (): Promise<Result<void, KoiError>> => {
        const e = verifyLease(lease);
        if (e) return { ok: false, error: e };
        // BC: harnesses that don't track tasks on the board call
        // `completeTask` as the session-end signal. Preserve that path.
        // For task-board harnesses the explicit `complete()` API and
        // the per-task transition path below are preferred.
        if (state.taskBoard.items.length === 0) {
          return publishTerminal("completed");
        }
        const { delta, found, remaining } = buildTaskUpdateDelta(taskId, "completed", result);
        if (!found) {
          return {
            ok: false,
            error: err("NOT_FOUND", `task ${taskId} not in_progress on board`, false, {
              taskId,
            }),
          };
        }
        if (remaining === 0) {
          // No live work remains. Pick the terminal phase that matches the
          // board's terminal mix:
          //  - all completed → publish "completed"
          //  - any failed/killed → publish "failed" so the durable phase
          //    reflects that not every tracked task succeeded
          // Either way we MUST publish a terminal — falling through to
          // softCheckpoint would write phase=active with no live work,
          // creating a zombie state on resume.
          const allCompleted =
            delta.taskBoard?.items.every((t: Task) => t.status === "completed") ?? true;
          if (allCompleted) {
            return publishTerminal("completed", undefined, () => delta);
          }
          return publishTerminal(
            "failed",
            "task board reached terminal state with non-completed items",
            () => delta,
          );
        }
        return softCheckpoint(delta);
      }),
    complete: (lease) =>
      withLock(async (): Promise<Result<void, KoiError>> => {
        const e = verifyLease(lease);
        if (e) return { ok: false, error: e };
        // Reject if any non-completed tracked work exists. Publishing
        // `completed` over pending/in_progress strands work; publishing
        // it over `failed`/`killed` items creates a durable contradiction
        // where the harness phase advertises success while the board
        // still records non-success outcomes. Callers must use fail()
        // or task-level transitions instead.
        const nonComplete = state.taskBoard.items.filter((t: Task) => t.status !== "completed");
        if (nonComplete.length > 0) {
          return {
            ok: false,
            error: err(
              "CONFLICT",
              `cannot complete: ${nonComplete.length} task(s) not in "completed" state`,
              false,
              { nonCompleteCount: nonComplete.length },
            ),
          };
        }
        return publishTerminal("completed");
      }),
    failTask: (lease, taskId, taskError) =>
      withLock(async (): Promise<Result<void, KoiError>> => {
        const e = verifyLease(lease);
        if (e) return { ok: false, error: e };
        // Honor TaskBoardConfig.maxRetries semantics: if the task has
        // already exhausted its retry budget, escalate to a terminal
        // failure instead of looping indefinitely.
        if (taskError.retryable) {
          // Prefer the live task-board's authoritative budget when the
          // host wires `getTaskMaxRetries` — that prevents drift between
          // the harness-config retry budget and the board-config budget.
          // Fall back to the validated, persisted harness budget. Untyped
          // task metadata is intentionally NOT consulted: only the
          // explicit, typed callback or the harness config can change
          // termination semantics.
          let maxRetries = state.effectiveTaskMaxRetries;
          if (cfg.getTaskMaxRetries) {
            try {
              const live = cfg.getTaskMaxRetries(taskId);
              if (typeof live === "number" && Number.isInteger(live) && live >= 0) {
                maxRetries = live;
              }
            } catch {
              // bridge threw — fall back to harness budget
            }
          }
          const current = state.taskBoard.items.find((t: Task) => t.id === taskId);
          // Only escalate to terminal if the task is *still* in_progress
          // for this callback. A stale duplicate from a prior attempt
          // (task already reset to pending or completed elsewhere) must
          // not durably fail the whole harness.
          if (current && current.status === "in_progress" && current.retries >= maxRetries) {
            const { delta } = buildTerminalFailDelta(taskId, taskError);
            return publishTerminal("failed", taskError.message, () => delta);
          }
        }
        if (taskError.retryable) {
          // Real retry transition: reset the matching in_progress task
          // back to pending, increment retries, bump version, clear
          // activeForm, attach the error. Persisted via softCheckpoint
          // so the scheduler can re-pick the task on the next turn.
          const tNow = now();
          let foundRetry = false;
          const items = state.taskBoard.items.map((t: Task) => {
            if (t.id === taskId && t.status === "in_progress") {
              foundRetry = true;
              // Mirror the canonical task-board retry transition: clear
              // `assignedTo` so a scheduler can re-claim, preserve
              // `lastAssignedTo` (it is set-once and never cleared), and
              // strip transient delegation metadata so a stale handoff
              // does not block re-assignment.
              const cleanedMeta =
                t.metadata && "delegatedTo" in t.metadata
                  ? Object.fromEntries(
                      Object.entries(t.metadata).filter(([k]) => k !== "delegatedTo"),
                    )
                  : t.metadata;
              // Version-skew backfill: pre-`lastAssignedTo` snapshots
              // may have `assignedTo` set without `lastAssignedTo`.
              // Preserve the worker identity before clearing `assignedTo`
              // so re-claim / orphan handling can still attribute work.
              const lastAssigned = t.lastAssignedTo !== undefined ? t.lastAssignedTo : t.assignedTo;
              const next: Task = {
                ...t,
                status: "pending",
                activeForm: undefined,
                assignedTo: undefined,
                ...(lastAssigned !== undefined && { lastAssignedTo: lastAssigned }),
                retries: t.retries + 1,
                version: t.version + 1,
                updatedAt: tNow,
                error: taskError,
                ...(cleanedMeta !== undefined && { metadata: cleanedMeta }),
              };
              return next;
            }
            return t;
          });
          if (!foundRetry && state.taskBoard.items.length > 0) {
            return {
              ok: false,
              error: err("NOT_FOUND", `task ${taskId} not in_progress on board`, false, {
                taskId,
              }),
            };
          }
          const retryDelta: StateDelta = foundRetry
            ? { taskBoard: { items, results: state.taskBoard.results } }
            : {};
          return softCheckpoint(retryDelta);
        }
        const { delta, found } = buildTerminalFailDelta(taskId, taskError);
        // Reject stale/out-of-order callbacks for a non-empty board: the
        // L0 contract only allows in_progress -> failed, and we must not
        // publish a `failed` harness while leaving a pending task with
        // no recorded error on the board.
        if (!found && state.taskBoard.items.length > 0) {
          return {
            ok: false,
            error: err("NOT_FOUND", `task ${taskId} not in_progress on board`, false, {
              taskId,
            }),
          };
        }
        return publishTerminal("failed", taskError.message, () => delta);
      }),
    dispose: (lease) =>
      withLock(async (): Promise<Result<void, KoiError>> => {
        clearTimer();
        if (state.phase !== "active") return { ok: true, value: undefined };
        if (lease) {
          const e = verifyLease(lease);
          if (e) return { ok: false, error: e };
        } else if (state.lease) {
          return {
            ok: false,
            error: err("STALE_REF", "active lease present; pass it to dispose", false),
          };
        }
        return publishTerminal("suspended", "disposed");
      }),
    status: getStatus,
    createMiddleware: (mwCfg?: CheckpointMiddlewareConfig): KoiMiddleware =>
      createCheckpointMiddleware({
        intervalTurns: mwCfg?.softCheckpointInterval ?? interval,
        onTurnStart,
        onTurnEnd,
      }),
  };

  return { ok: true, value: harness };
}
