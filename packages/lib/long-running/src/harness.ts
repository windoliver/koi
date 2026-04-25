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
    if (state.lease) activeLeases.delete(state.lease);
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
    while (state.inTurn && now() - start < deadlineMs) {
      await sleep(10);
    }
    return !state.inTurn;
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
    try {
      await cfg.sessionPersistence.setSessionStatus(sid, status);
    } catch {
      // best-effort
    }
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
      if (head.data.phase !== "suspended" && head.data.phase !== "active") {
        return {
          ok: false,
          error: err("CONFLICT", `cannot resume: head phase is ${head.data.phase}`, false),
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

    // Engine state is an OPTIMIZATION; transcript replay is the documented
    // fallback. If the session row is missing or unreadable, degrade
    // gracefully — do not strand a resumable harness on a stale row error.
    let carriedState: EngineState | undefined;
    if (expect === "resume" && head?.data.lastSessionId) {
      const priorRes = await cfg.sessionPersistence.loadSession(head.data.lastSessionId);
      if (priorRes.ok) carriedState = priorRes.value.lastEngineState;
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

  // Sentinel-typed capture: "skip" means saveState is not configured or the
  // capture threw, so we must NOT touch the session record. A defined or
  // explicit-undefined `state` value means we should overwrite the session's
  // `lastEngineState` with that value (`undefined` clears stale state).
  type CapturedEngineState =
    | { readonly skip: true }
    | { readonly skip: false; readonly value: EngineState | undefined };

  const captureEngineState = async (): Promise<CapturedEngineState> => {
    if (!cfg.saveState) return { skip: true };
    try {
      const value = (await cfg.saveState()) as EngineState | undefined;
      return { skip: false, value };
    } catch {
      return { skip: true };
    }
  };

  const writeCapturedEngineState = async (
    captured: CapturedEngineState,
    targetSessionId: string,
  ): Promise<void> => {
    // Bind the write to the session id captured at transition entry.
    // If a concurrent activate() has already advanced state.lastSessionId
    // to a fresh session, do NOT cross-contaminate by writing this
    // captured state into the new session row.
    if (captured.skip || state.lastSessionId !== targetSessionId) return;
    try {
      const sid = toSessionId(targetSessionId);
      const loadRes = await cfg.sessionPersistence.loadSession(sid);
      if (loadRes.ok) {
        await cfg.sessionPersistence.saveSession({
          ...loadRes.value,
          lastEngineState: captured.value,
          lastPersistedAt: now(),
        });
      }
    } catch {
      // best-effort
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
    // able to resume from the live execution point.
    const captured: CapturedEngineState =
      target === "suspended" ? await captureEngineState() : { skip: true };
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
      return {
        ok: false,
        error: err("TIMEOUT", "engine did not quiesce within abortTimeoutMs", true, {
          abortTimeoutMs,
        }),
      };
    }
    // Build the delta AFTER quiesce so any metrics/summaries advanced by a
    // late onTurnEnd are merged in, not silently overwritten.
    const delta = buildDelta();
    const snapshot = buildSnapshot(target, failureReason, delta);
    const putRes = await putSnapshot(snapshot);
    if (!putRes.ok) {
      const headRes = await loadHead();
      if (headRes.ok && headRes.value) state.lastNodeId = headRes.value.nodeId;
      const retry = await putSnapshot(buildSnapshot(target, failureReason, delta));
      if (!retry.ok) {
        state.terminating = false;
        return { ok: false, error: retry.error };
      }
    }
    // Snapshot is durable — now write the captured engine state. Atomicity:
    // if this write fails, the snapshot still reflects the published phase
    // and a subsequent resume will simply lack the optimization of fast
    // restart, falling back to transcript replay.
    if (sidAtEntry !== undefined) await writeCapturedEngineState(captured, sidAtEntry);
    commitDelta(delta);
    revokeLease();
    state.phase = target;
    state.failureReason = failureReason;
    if (state.lastSessionId) {
      const sid = toSessionId(state.lastSessionId);
      await persistSessionStatus(sid, target === "suspended" ? "idle" : "done");
    }
    await cfg.harnessStore.prune(chain, pruning);
    if (target === "completed" && cfg.onCompleted) await cfg.onCompleted(getStatus());
    if (target === "failed" && cfg.onFailed) {
      await cfg.onFailed(getStatus(), err("INTERNAL", failureReason ?? "harness failed", false));
    }
    return { ok: true, value: undefined };
  };

  const softCheckpoint = async (delta: StateDelta = {}): Promise<Result<void, KoiError>> => {
    if (state.phase !== "active") return { ok: true, value: undefined };
    if (state.terminating) return { ok: true, value: undefined };
    const sidAtEntry = state.lastSessionId;
    // Capture before put so the engine state matches the snapshot we're
    // about to publish; only persist the captured state after the
    // snapshot is durable.
    const captured = await captureEngineState();
    const snapshot = buildSnapshot("active", undefined, delta);
    const putRes = await putSnapshot(snapshot);
    if (!putRes.ok) return { ok: false, error: putRes.error };
    if (sidAtEntry !== undefined) await writeCapturedEngineState(captured, sidAtEntry);
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
      if (t.id === taskId && (t.status === "pending" || t.status === "in_progress")) {
        found = true;
        foundStartedAt = t.startedAt;
        // Mirror the L0 task-board terminal-transition rules: clear
        // transient `activeForm`, bump `version`, set `updatedAt`.
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
    const results =
      found && nextStatus === "completed"
        ? [
            ...state.taskBoard.results,
            {
              taskId: taskId as Task["id"],
              output: safeStringify(result),
              durationMs: foundStartedAt !== undefined ? Math.max(0, tNow - foundStartedAt) : 0,
            },
          ]
        : state.taskBoard.results;
    const taskBoard = { items, results };
    const remaining = items.filter(
      (t: Task) => t.status === "pending" || t.status === "in_progress",
    ).length;
    return { delta: { taskBoard }, found, remaining };
  };

  const onTurnStart = (): void => {
    state.inTurn = true;
  };
  const onTurnEnd = async (): Promise<void> => {
    state.turnCount += 1;
    state.metrics = { ...state.metrics, totalTurns: state.metrics.totalTurns + 1 };
    try {
      if (shouldSoftCheckpoint(state.turnCount, interval)) {
        await softCheckpoint();
      }
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
        if (state.taskBoard.items.length === 0) {
          return publishTerminal("completed");
        }
        const { delta, found, remaining } = buildTaskUpdateDelta(taskId, "completed", result);
        if (!found) {
          return {
            ok: false,
            error: err("NOT_FOUND", `task ${taskId} not in board`, false, { taskId }),
          };
        }
        if (remaining === 0) return publishTerminal("completed", undefined, () => delta);
        return softCheckpoint(delta);
      }),
    failTask: (lease, taskId, taskError) =>
      withLock(async (): Promise<Result<void, KoiError>> => {
        const e = verifyLease(lease);
        if (e) return { ok: false, error: e };
        if (taskError.retryable) return softCheckpoint();
        const { delta } = buildTaskUpdateDelta(taskId, "failed", null, taskError);
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
