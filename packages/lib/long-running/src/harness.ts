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
  type StartInput,
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

/**
 * Validate a persisted longRunningInitialInput value pulled from
 * arbitrary `SessionRecord.metadata`. Returns a typed StartInput when
 * the shape matches `{ kind: "text", text: string }` or
 * `{ kind: "messages", messages: array }`; otherwise undefined. Treat
 * malformed/missing payloads as fail-closed (resume falls through to
 * NOT_FOUND) rather than feeding untyped data into the engine adapter.
 * Inner message structure is not deep-validated — we only check the
 * outer envelope.
 */
function parsePersistedInitialInput(raw: unknown): StartInput | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  const obj = raw as { kind?: unknown; text?: unknown; messages?: unknown };
  if (obj.kind === "text" && typeof obj.text === "string") {
    return { kind: "text", text: obj.text };
  }
  if (obj.kind === "messages" && Array.isArray(obj.messages)) {
    return { kind: "messages", messages: obj.messages } as StartInput;
  }
  return undefined;
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
    const lease = state.lease;
    const sessionIdStr = state.lastSessionId;
    if (!lease || !sessionIdStr) {
      // No current owner — nothing to drain.
      while (state.inTurn && now() - start < deadlineMs) {
        await sleep(10);
      }
      return !state.inTurn;
    }
    const sessionId = toSessionId(sessionIdStr);
    // Run the host drain callback concurrently with the inTurn poll
    // and share a single absolute deadline. A slow but healthy turn
    // that completes anywhere within `deadlineMs` is accepted; only
    // genuine timeouts fail. The callback is bound to the revoked
    // lease so a global/stale callback cannot resolve based on
    // unrelated work. Hosts without background side effects can omit
    // quiesceEngine — we default to a no-op that resolves immediately,
    // so the gate reduces to the inTurn poll.
    const drain = cfg.quiesceEngine ?? (async () => undefined);
    const callbackPromise: Promise<"ok" | "err"> = drain({ sessionId, lease }).then(
      () => "ok",
      () => "err",
    );
    const outcomeBox: { value: "pending" | "ok" | "err" } = { value: "pending" };
    void callbackPromise.then((r) => {
      outcomeBox.value = r;
    });
    while ((state.inTurn || outcomeBox.value === "pending") && now() - start < deadlineMs) {
      await sleep(10);
    }
    const turnCleared = !state.inTurn;
    // If callback is still pending at the deadline, wait one tick for
    // microtask resolution before deciding.
    if (outcomeBox.value === "pending") {
      await Promise.race([
        callbackPromise.then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 0)),
      ]);
    }
    // Normal path: BOTH turn flag cleared AND callback resolved ok.
    if (turnCleared && outcomeBox.value === "ok") return true;
    // Stuck-middleware override: full deadline elapsed with inTurn
    // still true but the drain callback resolved ok — accept as wedge
    // unblock. Per the documented contract, hosts that omit
    // `quiesceEngine` declare they have no background side effects to
    // drain, so the default no-op resolving is sufficient proof. Hosts
    // with background work MUST provide quiesceEngine; failing to do
    // so is a host bug we cannot detect.
    //
    // Design rationale: this mirrors claude-code's AbortController
    // hierarchy pattern (StreamingToolExecutor.ts), which propagates
    // abort to children and trusts the signal alone — there is no
    // host-supplied drain proof in that model. Tightening this to
    // "host-callback-or-deadlock" would strand any host without
    // background work whenever a middleware bookkeeping bug leaves
    // inTurn=true. See review-loop persistent finding #3.
    const fullyTimedOut = now() - start >= deadlineMs;
    if (fullyTimedOut && !turnCleared && outcomeBox.value === "ok") return true;
    return false;
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

  const buildEngineInput = (
    signal: AbortSignal,
    st?: EngineState | undefined,
    initial?: StartInput,
  ): EngineInput => {
    if (st) return { kind: "resume", state: st, signal };
    if (initial) {
      // StartInput is statically narrowed to non-resume kinds. Attach
      // the freshly minted lease's signal so abort propagates to the
      // engine adapter.
      if (initial.kind === "messages") {
        return { kind: "messages", messages: initial.messages, signal };
      }
      return { kind: "text", text: initial.text, signal };
    }
    return { kind: "text", text: "", signal };
  };

  const activate = async (
    expect: "start" | "resume",
    initialInput?: StartInput,
  ): Promise<Result<StartResult, KoiError>> => {
    // Pre-serialize a recovery copy of initialInput when persistence
    // is enabled. We DO NOT mutate the live initialInput — JSON
    // round-tripping silently strips `undefined` / Function / Symbol
    // values and coerces Date/Map/class instances inside
    // ButtonBlock.payload / CustomBlock.data (typed as `unknown`),
    // which would change first-turn semantics on the happy path. By
    // persisting a separate normalized copy, a recovered first turn
    // may differ from the original — but that's the recovery path,
    // gated by `replayInitialInputOnResume`. Surface BigInt/circular
    // failures at the API boundary as VALIDATION.
    let initialInputForPersistence: StartInput | undefined;
    if (expect === "start" && initialInput !== undefined && cfg.persistInitialInput === true) {
      try {
        initialInputForPersistence = JSON.parse(JSON.stringify(initialInput)) as StartInput;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          error: err(
            "VALIDATION",
            `start() initialInput is not JSON-serializable (required when persistInitialInput is enabled): ${msg}`,
            false,
          ),
        };
      }
    }
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
    // start() is a fresh-run API: when restarting from a terminal head
    // (completed/failed), drop per-run accumulators carried by
    // adoptHead so the new run does not inherit completed/failed task
    // state, stale summaries/artifacts, or prior metrics. Snapshot
    // chain linkage (lastNodeId) is preserved so the new active
    // snapshot still chains to the prior head for history.
    //
    // Snapshot the adopted state BEFORE mutating so we can restore it
    // verbatim if saveSession()/putSnapshot() fail — otherwise an
    // activation failure would leave status() advertising a fresh-run
    // shell of empty board/metrics with the prior phase still durable
    // on disk.
    const preStartSnapshot =
      expect === "start"
        ? {
            taskBoard: state.taskBoard,
            summaries: state.summaries,
            keyArtifacts: state.keyArtifacts,
            metrics: state.metrics,
            lastSessionId: state.lastSessionId,
            startedAt: state.startedAt,
            sessionSeq: state.sessionSeq,
            failureReason: state.failureReason,
            terminating: state.terminating,
            effectiveTaskMaxRetries: state.effectiveTaskMaxRetries,
          }
        : undefined;
    if (expect === "start") {
      // Per-run accumulators reset; cumulative HarnessMetrics PRESERVED
      // across runs per the core contract ("Accumulated metrics across
      // all sessions"). Operators rely on these counters for
      // longitudinal monitoring; zeroing them on every restart would
      // permanently erase telemetry.
      state.taskBoard = EMPTY_TASK_BOARD;
      state.summaries = [];
      state.keyArtifacts = [];
      state.lastSessionId = undefined;
    }
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
      if (carriedState === undefined && cfg.replayInitialInputOnResume === true) {
        // Pre-checkpoint crash recovery (opt-in via
        // replayInitialInputOnResume): if start() persisted the
        // initial prompt and the host has explicitly accepted the
        // side-effect-replay risk, use it as the engine input.
        // Without this opt-in we keep the strict fail-closed behavior
        // (NOT_FOUND below) — replaying the first turn duplicates any
        // side effects it began before the crash.
        const rawPersisted = priorRes.value.metadata?.longRunningInitialInput;
        const persistedInitial = parsePersistedInitialInput(rawPersisted);
        if (persistedInitial !== undefined) {
          initialInput = persistedInitial;
          // carriedState remains undefined — buildEngineInput will
          // emit a text/messages input, not a resume input.
          //
          // Re-persist on the new session row UNCONDITIONALLY so a
          // SECOND crash before the first soft checkpoint stays
          // recoverable, even if the operator restarted under a
          // config with persistInitialInput=false. The host already
          // committed to replay semantics via replayInitialInputOnResume,
          // so the durability commitment must follow.
          initialInputForPersistence = persistedInitial;
        }
      }
      if (carriedState === undefined && initialInput === undefined) {
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
        if (carriedState === undefined && initialInput === undefined) {
          return {
            ok: false,
            error: err(
              "NOT_FOUND",
              cfg.legacyResumeFallback
                ? "cannot resume: legacyResumeFallback returned no state for prior session"
                : "cannot resume: prior session has no lastEngineState, no longRunningInitialInput, and no legacyResumeFallback was supplied",
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
      // Persist as `idle` until the active snapshot is durable. Rows
      // with status `running` are crash candidates on recovery; if the
      // snapshot publish fails, an indeterminate row in `running`
      // would manufacture phantom recovery work. Flip to `running`
      // only after the active snapshot commits successfully.
      status: "idle",
      // Persist the initial start input on the session row so a crash
      // before the first soft checkpoint (which is when the engine
      // adapter writes lastEngineState) can replay the same first-turn
      // prompt/messages on recovery instead of restarting from an
      // empty input. The same persistence applies on `resume` paths
      // that bootstrap from a previously persisted initialInput — a
      // second crash before the first checkpoint must remain
      // recoverable, so we re-persist on the new session row.
      //
      // Privacy note: `messages` start inputs contain raw user
      // content. Hosts that process sensitive prompts and don't need
      // pre-checkpoint crash recovery can opt out via
      // `cfg.persistInitialInput: false` to avoid durable exposure
      // of prompt content in generic session metadata.
      metadata:
        initialInputForPersistence !== undefined
          ? { longRunningInitialInput: initialInputForPersistence }
          : {},
    };
    const restorePreStart = (): void => {
      if (!preStartSnapshot) return;
      state.taskBoard = preStartSnapshot.taskBoard;
      state.summaries = preStartSnapshot.summaries;
      state.keyArtifacts = preStartSnapshot.keyArtifacts;
      state.metrics = preStartSnapshot.metrics;
      state.lastSessionId = preStartSnapshot.lastSessionId;
      state.startedAt = preStartSnapshot.startedAt;
      state.sessionSeq = preStartSnapshot.sessionSeq;
      state.failureReason = preStartSnapshot.failureReason;
      state.terminating = preStartSnapshot.terminating;
      state.effectiveTaskMaxRetries = preStartSnapshot.effectiveTaskMaxRetries;
    };
    // Pre-snapshot cleanup: no putSnapshot has been attempted yet, so a
    // committed active head is impossible. Always revoke the lease,
    // best-effort remove the (possibly committed) session row, and
    // restore in-memory state from the pre-start snapshot. Used on
    // both Result-Err and thrown saveSession failures.
    const preSnapshotCleanup = async (): Promise<void> => {
      revokeLease();
      try {
        await cfg.sessionPersistence.removeSession(sid);
      } catch {
        /* best-effort cleanup */
      }
      restorePreStart();
    };
    // Post-snapshot rollback. Order matters: reload the durable head
    // BEFORE deciding whether to remove the new session row, because
    // putSnapshot can be ambiguous — it may have committed and then
    // reported failure (network/transport).
    //
    // Three outcomes:
    //   - "committed": head points at our new sid → snapshot is
    //     durable; keep the session row and lease, adopt the head.
    //   - "rolled-back": head readable AND does NOT point at our sid
    //     → snapshot did not land; revoke lease, remove session row.
    //   - "indeterminate": head unreadable → cannot prove either way;
    //     do NOT remove the session row (would orphan a possibly-live
    //     active head). Caller surfaces a retryable error.
    const rollbackActivation = async (): Promise<"committed" | "rolled-back" | "indeterminate"> => {
      let headAfter: SnapshotNode<HarnessSnapshot> | undefined;
      let headReadable = false;
      try {
        const r = await loadHead();
        if (r.ok) {
          headReadable = true;
          headAfter = r.value;
        }
      } catch {
        /* head unreadable */
      }
      if (headAfter && headAfter.data.lastSessionId === sid) {
        adoptHead(headAfter);
        return "committed";
      }
      if (!headReadable) {
        // Conservative: leave session row and in-memory state intact;
        // operator/caller retry can re-read head when storage recovers.
        return "indeterminate";
      }
      revokeLease();
      try {
        await cfg.sessionPersistence.removeSession(sid);
      } catch {
        /* best-effort cleanup */
      }
      if (headAfter) {
        adoptHead(headAfter);
      } else {
        restorePreStart();
      }
      return "rolled-back";
    };

    let saveRes: Result<void, KoiError>;
    try {
      saveRes = await cfg.sessionPersistence.saveSession(sessionRec);
    } catch (e: unknown) {
      await preSnapshotCleanup();
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: err("EXTERNAL", `saveSession threw: ${msg}`, true) };
    }
    if (!saveRes.ok) {
      await preSnapshotCleanup();
      return { ok: false, error: saveRes.error };
    }

    const snapshot = buildSnapshot("active");
    let putRes: Result<SnapshotNode<HarnessSnapshot>, KoiError> | undefined;
    let putThrew: unknown;
    try {
      putRes = await putSnapshot(snapshot);
    } catch (e: unknown) {
      putThrew = e;
    }
    if (putThrew !== undefined || (putRes && !putRes.ok)) {
      // Ambiguous: the put may have committed before the throw/error
      // surface. Let rollback consult the durable head:
      //   committed     → fall through to success path
      //   rolled-back   → propagate the original error
      //   indeterminate → return retryable EXTERNAL; do not strand
      //                   the (possibly durable) active head.
      const outcome = await rollbackActivation();
      if (outcome === "indeterminate") {
        const cause =
          putThrew !== undefined
            ? putThrew instanceof Error
              ? putThrew.message
              : String(putThrew)
            : putRes && !putRes.ok
              ? putRes.error.message
              : "unknown";
        return {
          ok: false,
          error: err(
            "EXTERNAL",
            `putSnapshot indeterminate (${cause}); durable head unreadable, retry to reconcile`,
            true,
          ),
        };
      }
      if (outcome === "rolled-back") {
        if (putThrew !== undefined) {
          const msg = putThrew instanceof Error ? putThrew.message : String(putThrew);
          return { ok: false, error: err("EXTERNAL", `putSnapshot threw: ${msg}`, true) };
        }
        if (putRes && !putRes.ok) return { ok: false, error: putRes.error };
      }
      // outcome === "committed": fall through to success.
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
    // Snapshot is durable. Flip the new session row from `idle` to
    // `running` so recovery treats it as a live worker per the L0
    // contract (status="running" identifies crash candidates;
    // session.ts:20-28). This is part of the success contract — NOT
    // best-effort. If the flip fails after retry, the activation has
    // produced an active head whose backing session is still `idle`,
    // which would let recovery skip a real interrupted run on a later
    // crash. Roll forward to `failed` so the head and session row
    // agree on a non-live state.
    //
    // Note: a SIGKILL/process-crash between putSnapshot(active) and
    // this status flip leaves an active head with an idle session
    // row. That window is intrinsic to non-2PC stores and recovery
    // callers should reconcile by treating active heads as crash
    // candidates regardless of session status; see session.ts:251.
    let runningFlipped = false;
    for (let attempt = 0; attempt < 2 && !runningFlipped; attempt++) {
      try {
        const r = await cfg.sessionPersistence.setSessionStatus(sid, "running");
        if (r.ok) runningFlipped = true;
      } catch {
        /* retry once */
      }
    }
    if (!runningFlipped) {
      // Roll forward: publish a failed snapshot so the durable head is
      // non-active, mark the session row done, and surface an error.
      const failReason = "activation failed: session status flip to running did not succeed";
      const failedSnap = buildSnapshot("failed", failReason);
      let failedPut = await putSnapshot(failedSnap);
      if (!failedPut.ok) {
        // Conflict-retry path matches publishTerminal.
        const headRes = await loadHead();
        if (headRes.ok && headRes.value) state.lastNodeId = headRes.value.nodeId;
        failedPut = await putSnapshot(buildSnapshot("failed", failReason));
      }
      revokeLease();
      try {
        await cfg.sessionPersistence.setSessionStatus(sid, "done");
      } catch {
        /* best-effort */
      }
      state.phase = "failed";
      state.failureReason = failReason;
      restorePreStart();
      return {
        ok: false,
        error: err("EXTERNAL", failReason, true),
      };
    }
    state.phase = "active";
    state.turnCount = 0;

    if (cfg.timeoutMs !== undefined) {
      // Capture the lease at schedule time. When the timer fires we
      // verify the lease is STILL active — without this check, a
      // timeout queued for session A could fire after A was paused
      // and B started, publishing a bogus "failed" terminal for B.
      const scheduledLease = lease;
      state.timeoutHandle = setTimeout(() => {
        void withLock(async () => {
          if (state.lease !== scheduledLease) return { ok: true, value: undefined };
          return publishTerminal("failed", "TIMEOUT");
        });
      }, cfg.timeoutMs);
    }

    return {
      ok: true,
      value: {
        lease,
        engineInput: buildEngineInput(lease.abort, carriedState, initialInput),
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
    // If a prior pause attempt already captured post-quiesce engine
    // state for this lease, skip the pre-flight feasibility check —
    // the authoritative capture is already in hand and the engine is
    // already aborted from that prior attempt. Otherwise, for
    // "suspended", do a pre-flight saveState BEFORE abort so a
    // transient saveState fault leaves the live engine intact for
    // retry. This is only a feasibility check — the authoritative
    // capture happens AFTER quiesce so it matches the fully-stopped
    // engine.
    const priorCachedCapture =
      target === "suspended" && state.lease ? captureCache.get(state.lease) : undefined;
    if (target === "suspended" && !priorCachedCapture) {
      // Pre-flight saveState BEFORE abort so a transient saveState
      // fault leaves the live engine intact for retry. Feasibility
      // check ONLY — the value is discarded. The authoritative
      // capture happens AFTER quiesce so it reflects the fully-drained
      // engine; resuming from a pre-abort capture would replay any
      // work that was in flight at abort time.
      //
      // Design rationale: v1 long-running had no abort/quiesce — pause
      // was strictly post-turn (archive/v1/packages/sched/long-running
      // /src/harness.ts:469-484). v2 supports soft checkpoints during
      // turns and abort-mid-turn pause, which forces this two-phase
      // capture. We deliberately do NOT fall back to the pre-abort
      // capture if post-quiesce fails: that would resume from a state
      // older than the snapshot delta accounts for. On post-quiesce
      // capture failure we roll forward to `failed` instead. See
      // review-loop persistent finding #1.
      const preflight = await captureEngineState();
      if (preflight.kind === "error") {
        state.terminating = false;
        return { ok: false, error: preflight.error };
      }
    }
    // Capture succeeded — fire abort so the engine stops emitting side
    // effects. DO NOT revoke the lease (and do NOT commit the
    // speculative delta) until the terminal snapshot is durably
    // published. On quiesce timeout or store failure, the caller can
    // retry the same transition with the same lease and same delta.
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
    // POST-QUIESCE capture: the engine is fully drained, so this
    // capture is the authoritative resume point. Reuse a cached
    // post-quiesce capture if a prior retry attempt got this far.
    let captured: CapturedEngineState;
    if (target !== "suspended") {
      captured = { kind: "skip" };
    } else if (priorCachedCapture) {
      captured = priorCachedCapture;
    } else {
      // Authoritative post-quiesce capture only. Pre-abort captures
      // are NOT used as a fallback — they would resume from a state
      // older than the work the snapshot delta accounts for.
      captured = await captureEngineState();
    }
    if (target === "suspended" && captured.kind === "error") {
      // Post-quiesce capture failed. Engine is
      // already aborted/quiesced. Stranded-active is the worst outcome
      // — roll forward to `failed`, preserving the caller's
      // session-result delta. Route through the same conflict-retry
      // helper as the normal terminal publish path.
      const captureErr = captured.error;
      const rolledDelta = buildDelta();
      const failReason = `pause aborted but saveState failed: ${captureErr.message}`;
      const failedSnap = buildSnapshot("failed", failReason, rolledDelta);
      let putRes = await putSnapshot(failedSnap);
      if (!putRes.ok) {
        // Conflict/transient: reload head and retry once, matching the
        // normal terminal publish path below.
        const headRes = await loadHead();
        if (headRes.ok && headRes.value) state.lastNodeId = headRes.value.nodeId;
        putRes = await putSnapshot(buildSnapshot("failed", failReason, rolledDelta));
      }
      if (!putRes.ok) {
        state.terminating = false;
        return {
          ok: false,
          error: err(
            "INTERNAL",
            `pause aborted, saveState failed (${captureErr.message}), and failed-snapshot roll-forward also failed (${putRes.error.message})`,
            true,
          ),
        };
      }
      commitDelta(rolledDelta);
      revokeLease();
      state.phase = "failed";
      state.failureReason = failReason;
      if (state.lastSessionId) {
        await persistSessionStatus(toSessionId(state.lastSessionId), "done");
      }
      // Run the same post-commit finalization as the normal `failed`
      // terminal: prune, onFailed observability hook, and a follow-up
      // annotated snapshot if any post-commit step appended notes to
      // failureReason. Errors here are best-effort.
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
      if (cfg.onFailed) {
        try {
          await cfg.onFailed(getStatus(), err("INTERNAL", failReason, false));
        } catch (e: unknown) {
          noteFailure("onFailed", e);
        }
      }
      if (state.failureReason !== postCommitBefore) {
        try {
          const annotated = buildSnapshot("failed", state.failureReason, rolledDelta);
          const annRes = await putSnapshot(annotated);
          if (!annRes.ok) {
            state.failureReason = `${state.failureReason}; annotate: ${annRes.error.message}`;
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          state.failureReason = `${state.failureReason}; annotate: ${msg}`;
        }
      }
      state.terminating = false;
      // Surface as non-retryable INTERNAL: pause did not produce a
      // suspended head, but the run is already durably failed —
      // retrying pause would just return STALE_REF.
      return {
        ok: false,
        error: err("INTERNAL", failReason, false, { cause: captureErr }),
      };
    }
    // Memoize the post-quiesce capture so a snapshot-publish retry on
    // the same lease reuses it instead of re-asking a stopped engine.
    // Only successful captures are memoized — errors above already
    // returned via the roll-forward path.
    if (
      target === "suspended" &&
      state.lease &&
      !priorCachedCapture &&
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
  const onTurnEnd = async (intervalOverride?: number): Promise<void> => {
    state.turnCount += 1;
    state.metrics = { ...state.metrics, totalTurns: state.metrics.totalTurns + 1 };
    const effectiveInterval = intervalOverride ?? interval;
    try {
      if (shouldSoftCheckpoint(state.turnCount, effectiveInterval)) {
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
    start: (initialInput?: StartInput) => withLock(() => activate("start", initialInput)),
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
    createMiddleware: (mwCfg?: CheckpointMiddlewareConfig): KoiMiddleware => {
      // Validate the per-middleware override with the same rules as
      // the harness-level cfg.softCheckpointInterval (positive
      // integer). Hard-reject invalid values rather than silently
      // coercing — silently falling back to the harness default would
      // mask configuration bugs, and silently honoring 0/negative
      // would disable durable checkpoints entirely.
      const override = mwCfg?.softCheckpointInterval;
      if (override !== undefined) {
        if (!Number.isInteger(override) || override <= 0) {
          throw new Error(
            `createMiddleware: softCheckpointInterval must be a positive integer (got ${String(override)})`,
          );
        }
      }
      const intervalTurns = override ?? interval;
      return createCheckpointMiddleware({
        intervalTurns,
        onTurnStart,
        onTurnEnd: () => onTurnEnd(intervalTurns),
      });
    },
  };

  return { ok: true, value: harness };
}
