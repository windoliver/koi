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
  type ResumeResult,
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
    timeoutHandle: undefined,
    lease: undefined,
    abortController: undefined,
  };

  const buildSnapshot = (phase: HarnessPhase, failureReason?: string): HarnessSnapshot =>
    buildHarnessSnapshot({
      harnessId: cfg.harnessId,
      agentId: cfg.agentId,
      phase,
      sessionSeq: state.sessionSeq,
      taskBoard: state.taskBoard,
      summaries: state.summaries,
      keyArtifacts: state.keyArtifacts,
      metrics: state.metrics,
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

    const sid: SessionId = toSessionId(crypto.randomUUID());
    state.lastSessionId = sid;
    const lease = mintLease(sid);

    const carriedState = head?.data && expect === "resume" ? undefined : undefined;
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
        void publishTerminal("failed", "TIMEOUT");
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

  const publishTerminal = async (
    target: "suspended" | "completed" | "failed",
    failureReason?: string,
  ): Promise<Result<void, KoiError>> => {
    if (state.phase !== "active") return { ok: true, value: undefined };
    clearTimer();
    revokeLease();
    const quiet = await quiesce(abortTimeoutMs);
    if (!quiet) {
      return {
        ok: false,
        error: err("TIMEOUT", "engine did not quiesce within abortTimeoutMs", false, {
          abortTimeoutMs,
        }),
      };
    }
    const snapshot = buildSnapshot(target, failureReason);
    const putRes = await putSnapshot(snapshot);
    if (!putRes.ok) {
      // retry once with fresh head
      const headRes = await loadHead();
      if (headRes.ok && headRes.value) state.lastNodeId = headRes.value.nodeId;
      const retry = await putSnapshot(buildSnapshot(target, failureReason));
      if (!retry.ok) return { ok: false, error: retry.error };
    }
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

  const softCheckpoint = async (): Promise<Result<void, KoiError>> => {
    if (state.phase !== "active") return { ok: true, value: undefined };
    if (cfg.saveState && state.lastSessionId) {
      try {
        const engineState = (await cfg.saveState()) as EngineState | undefined;
        const sid = toSessionId(state.lastSessionId);
        const loadRes = await cfg.sessionPersistence.loadSession(sid);
        if (loadRes.ok) {
          const updated: SessionRecord = {
            ...loadRes.value,
            lastEngineState: engineState ?? loadRes.value.lastEngineState,
            lastPersistedAt: now(),
          };
          await cfg.sessionPersistence.saveSession(updated);
        }
      } catch {
        // best-effort: caller's saveState failure should not abort the turn
      }
    }
    const snapshot = buildSnapshot("active");
    const putRes = await putSnapshot(snapshot);
    if (!putRes.ok) return { ok: false, error: putRes.error };
    return { ok: true, value: undefined };
  };

  const onTurnStart = (): void => {
    state.inTurn = true;
  };
  const onTurnEnd = async (): Promise<void> => {
    state.inTurn = false;
    state.turnCount += 1;
    state.metrics = { ...state.metrics, totalTurns: state.metrics.totalTurns + 1 };
    if (shouldSoftCheckpoint(state.turnCount, interval)) {
      await softCheckpoint();
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
    start: () => activate("start"),
    resume: async (): Promise<Result<ResumeResult, KoiError>> => activate("resume"),
    pause: async (lease, _result): Promise<Result<void, KoiError>> => {
      const e = verifyLease(lease);
      if (e) return { ok: false, error: e };
      return publishTerminal("suspended");
    },
    fail: async (lease, error): Promise<Result<void, KoiError>> => {
      const e = verifyLease(lease);
      if (e) return { ok: false, error: e };
      return publishTerminal("failed", error.message);
    },
    completeTask: async (lease, _taskId, _result): Promise<Result<void, KoiError>> => {
      const e = verifyLease(lease);
      if (e) return { ok: false, error: e };
      // In the scope-reduced design, the caller owns the task board; the
      // harness only observes session-ending semantics. Treat empty-board
      // as the trigger via taskBoard.items inspection.
      const remaining = state.taskBoard.items.filter(
        (t: Task) => t.status === "pending" || t.status === "in_progress",
      );
      if (remaining.length === 0) return publishTerminal("completed");
      return softCheckpoint();
    },
    failTask: async (lease, _taskId, taskError): Promise<Result<void, KoiError>> => {
      const e = verifyLease(lease);
      if (e) return { ok: false, error: e };
      if (taskError.retryable) return softCheckpoint();
      return publishTerminal("failed", taskError.message);
    },
    dispose: async (lease): Promise<Result<void, KoiError>> => {
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
    },
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
