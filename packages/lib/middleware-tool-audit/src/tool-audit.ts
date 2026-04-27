/**
 * Tool audit middleware — tracks tool usage and emits lifecycle signals.
 *
 * Observes tool availability via wrapModelCall, records call outcomes via
 * wrapToolCall, and computes lifecycle signals on session end.
 *
 * Phase "observe", priority 100: outermost observation layer.
 */

import type { SessionId } from "@koi/core";
import type {
  CapabilityFragment,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import type { ToolAuditConfig } from "./config.js";
import { validateToolAuditConfig } from "./config.js";
import { computeLifecycleSignals } from "./signals.js";
import type {
  ToolAuditMiddleware,
  ToolAuditResult,
  ToolAuditSnapshot,
  ToolAuditStore,
  ToolUsageRecord,
} from "./types.js";

/** Mutable internal record used inside the closure. Internal — not exported. */
interface MutableToolRecord {
  toolName: string;
  callCount: number;
  successCount: number;
  failureCount: number;
  lastUsedAt: number;
  totalLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  sessionsAvailable: number;
  sessionsUsed: number;
}

function createEmptyRecord(toolName: string): MutableToolRecord {
  return {
    toolName,
    callCount: 0,
    successCount: 0,
    failureCount: 0,
    lastUsedAt: 0,
    totalLatencyMs: 0,
    minLatencyMs: Number.POSITIVE_INFINITY,
    maxLatencyMs: 0,
    sessionsAvailable: 0,
    sessionsUsed: 0,
  };
}

function toImmutableRecord(record: MutableToolRecord): ToolUsageRecord {
  const avgLatencyMs = record.callCount > 0 ? record.totalLatencyMs / record.callCount : 0;
  return {
    toolName: record.toolName,
    callCount: record.callCount,
    successCount: record.successCount,
    failureCount: record.failureCount,
    lastUsedAt: record.lastUsedAt,
    avgLatencyMs,
    minLatencyMs: record.minLatencyMs === Number.POSITIVE_INFINITY ? 0 : record.minLatencyMs,
    maxLatencyMs: record.maxLatencyMs,
    totalLatencyMs: record.totalLatencyMs,
    sessionsAvailable: record.sessionsAvailable,
    sessionsUsed: record.sessionsUsed,
  };
}

/**
 * Merge a persisted snapshot INTO existing in-memory state. Used after a
 * delayed-success hydration so usage data captured during a `store.load()`
 * outage isn't dropped when disk eventually becomes reachable.
 *
 * Counters are summed (callCount, sessionsAvailable, etc.). Latency
 * extremes take min/max. `lastUsedAt` takes the larger timestamp.
 */
function mergeSnapshotIntoMemory(
  tools: Map<string, MutableToolRecord>,
  snapshot: ToolAuditSnapshot,
): void {
  for (const [name, fromDisk] of Object.entries(snapshot.tools)) {
    const inMem = tools.get(name);
    if (inMem === undefined) {
      tools.set(name, {
        toolName: fromDisk.toolName,
        callCount: fromDisk.callCount,
        successCount: fromDisk.successCount,
        failureCount: fromDisk.failureCount,
        lastUsedAt: fromDisk.lastUsedAt,
        totalLatencyMs: fromDisk.totalLatencyMs,
        minLatencyMs:
          fromDisk.minLatencyMs === 0 ? Number.POSITIVE_INFINITY : fromDisk.minLatencyMs,
        maxLatencyMs: fromDisk.maxLatencyMs,
        sessionsAvailable: fromDisk.sessionsAvailable,
        sessionsUsed: fromDisk.sessionsUsed,
      });
      continue;
    }
    inMem.callCount += fromDisk.callCount;
    inMem.successCount += fromDisk.successCount;
    inMem.failureCount += fromDisk.failureCount;
    inMem.totalLatencyMs += fromDisk.totalLatencyMs;
    inMem.sessionsAvailable += fromDisk.sessionsAvailable;
    inMem.sessionsUsed += fromDisk.sessionsUsed;
    inMem.lastUsedAt = Math.max(inMem.lastUsedAt, fromDisk.lastUsedAt);
    if (fromDisk.minLatencyMs > 0) {
      inMem.minLatencyMs = Math.min(inMem.minLatencyMs, fromDisk.minLatencyMs);
    }
    inMem.maxLatencyMs = Math.max(inMem.maxLatencyMs, fromDisk.maxLatencyMs);
  }
}

function buildSnapshot(
  tools: Map<string, MutableToolRecord>,
  totalSessions: number,
  clock: () => number,
): ToolAuditSnapshot {
  const toolsRecord: Record<string, ToolUsageRecord> = {};
  for (const [name, record] of tools) {
    toolsRecord[name] = toImmutableRecord(record);
  }
  return {
    tools: toolsRecord,
    totalSessions,
    lastUpdatedAt: clock(),
  };
}

const EMPTY_SNAPSHOT: ToolAuditSnapshot = {
  tools: {},
  totalSessions: 0,
  lastUpdatedAt: 0,
};

function createFallbackStore(): ToolAuditStore {
  // let: snapshot is reassigned on each save
  let stored: ToolAuditSnapshot = EMPTY_SNAPSHOT;
  return {
    load: (): ToolAuditSnapshot => stored,
    save: (snapshot): void => {
      stored = snapshot;
    },
  };
}

/** Per-session mutable state for tool audit tracking. */
interface ToolAuditSessionState {
  readonly sessionId: SessionId;
  readonly sessionAvailableTools: Set<string>;
  readonly sessionUsedTools: Set<string>;
  /**
   * True after onSessionEnd has folded what it could and timed out
   * waiting for in-flight calls. Late completions hit the late-fold
   * path which folds their delta into the global aggregate and queues
   * a follow-up persist (#review-round38-F1).
   */
  cleanedUp: boolean;
  /**
   * Per-session call/latency counters. Kept ISOLATED from the global
   * `tools` aggregate until onSessionEnd so concurrent persists from
   * other sessions cannot capture this session's in-flight work
   * (started calls without outcomes, or work that may later abort).
   * #review-round27-F2.
   */
  readonly localTools: Map<string, MutableToolRecord>;
  /**
   * Promises representing tool calls currently awaiting outcome.
   * onSessionEnd awaits all of them before folding localTools into the
   * global aggregate so post-await success/failure/latency updates
   * cannot be lost on early teardown (cancellation, timeout, stream
   * failure). #review-round36-F1.
   */
  readonly inFlight: Set<Promise<void>>;
  dirty: boolean;
}

/**
 * Fold session-local counters into the shared aggregate, then ZERO the
 * local entries. Subsequent mutations to local records (e.g. late tool
 * completions after a session-end drain timeout) accumulate fresh
 * deltas that can be folded again — preventing late outcomes from being
 * orphaned (#review-round38-F1). Returns true if any local record had
 * non-zero counters to fold.
 */
function foldLocalIntoGlobal(
  global: Map<string, MutableToolRecord>,
  local: Map<string, MutableToolRecord>,
): boolean {
  let folded = false;
  for (const [name, l] of local) {
    const hasDelta =
      l.callCount > 0 ||
      l.successCount > 0 ||
      l.failureCount > 0 ||
      l.totalLatencyMs > 0 ||
      l.maxLatencyMs > 0 ||
      l.lastUsedAt > 0;
    if (!hasDelta) continue;
    folded = true;
    const g = global.get(name);
    if (g === undefined) {
      global.set(name, { ...l });
    } else {
      g.callCount += l.callCount;
      g.successCount += l.successCount;
      g.failureCount += l.failureCount;
      g.totalLatencyMs += l.totalLatencyMs;
      g.lastUsedAt = Math.max(g.lastUsedAt, l.lastUsedAt);
      if (l.minLatencyMs !== Number.POSITIVE_INFINITY) {
        g.minLatencyMs = Math.min(g.minLatencyMs, l.minLatencyMs);
      }
      g.maxLatencyMs = Math.max(g.maxLatencyMs, l.maxLatencyMs);
    }
    // Zero local so future mutations accumulate as a fresh delta.
    l.callCount = 0;
    l.successCount = 0;
    l.failureCount = 0;
    l.totalLatencyMs = 0;
    l.minLatencyMs = Number.POSITIVE_INFINITY;
    l.maxLatencyMs = 0;
    l.lastUsedAt = 0;
  }
  return folded;
}

const CAPABILITY_FRAGMENT: CapabilityFragment = {
  label: "tool-audit",
  description: "Tool usage tracking and lifecycle signals active",
};

/** Creates tool audit middleware that tracks usage and emits lifecycle signals. */
export function createToolAuditMiddleware(config: ToolAuditConfig): ToolAuditMiddleware {
  // Fail fast at construction on malformed config — selector + recovery
  // factories already do this. Without it, bad clock / store / callback
  // values pass into hot paths (buildSnapshot, recordOnSessionStart,
  // onSessionEnd) and fail mid-traffic instead of at startup
  // (#review-round24-F2).
  const validated = validateToolAuditConfig(config);
  if (!validated.ok) {
    throw KoiRuntimeError.from(validated.error.code, validated.error.message);
  }
  const validConfig = validated.value;
  const store = validConfig.store ?? createFallbackStore();
  const clock = validConfig.clock ?? Date.now;
  const { onAuditResult, onError } = validConfig;
  const drainTimeoutMs = validConfig.sessionEndDrainTimeoutMs ?? 5000;

  const tools = new Map<string, MutableToolRecord>();
  const sessionStates = new Map<SessionId, ToolAuditSessionState>();
  // let: in-flight load promise — concurrent first sessions share it. Cleared
  // on rejection so a transient failure doesn't permanently disconnect the
  // store; cleared on success too because `hydrated` then guards re-entry.
  let loadPromise: Promise<ToolAuditSnapshot> | undefined;
  // let: serialization queue for store.save() so concurrent onSessionEnd
  // calls cannot race and overwrite a newer snapshot with a stale one.
  // Each save is chained off the previous one's settlement.
  let savePromise: Promise<void> = Promise.resolve();
  // let: true after the snapshot has been merged into in-memory state exactly
  // once. Guards against (a) double-hydration on race, (b) using `tools.size`
  // as a sentinel — which fails when the snapshot itself is empty, and
  // (c) persisting a fresh snapshot before initial hydration succeeds.
  let hydrated = false;
  // let: accumulated session count
  let totalSessions = 0;
  // let: snapshot of the last value we observed on disk (post-hydrate or
  // post-save). Used as the baseline for additive-delta merges so concurrent
  // writers' increments aren't lost. Empty until first successful hydrate.
  let baselineSnapshot: ToolAuditSnapshot = EMPTY_SNAPSHOT;
  // let: true when a concurrent session ended dirty but skipped its own
  // save because other sessions were still active. The tail (last session
  // to end while sessionStates is empty) drains it (#review-round17-F1).
  let pendingPersist = false;
  // let: set when persistWithRetry threw — a transient store outage may
  // strand committed in-memory counters indefinitely if subsequent clean
  // sessions skip the save path. Forces every onSessionEnd to retry the
  // write until it succeeds (#review-round33-F1).
  let pendingFailedPersist = false;
  // let: snapshot from the most recent SUCCESSFUL persistWithRetry. Used
  // by generateReport so on-demand callers cannot page or auto-disable
  // on uncommitted in-memory state (#review-round33-F3).
  let lastCommittedSnapshot: ToolAuditSnapshot = EMPTY_SNAPSHOT;

  function getOrCreateRecord(toolName: string): MutableToolRecord {
    const existing = tools.get(toolName);
    if (existing !== undefined) return existing;
    const record = createEmptyRecord(toolName);
    tools.set(toolName, record);
    return record;
  }

  async function recordOnSessionStart(ctx: SessionContext): Promise<void> {
    if (!hydrated) {
      try {
        loadPromise ??= Promise.resolve(store.load());
        const snapshot = await loadPromise;
        if (!hydrated) {
          // Merge (rather than replace) the on-disk snapshot into memory.
          // This preserves any counters / sessions captured while the store
          // was unreachable, instead of silently overwriting them when the
          // store recovers. For the cold-start case (no in-memory state),
          // merge degenerates to a copy of the disk snapshot.
          const hadOutageDeltas = tools.size > 0 || totalSessions > 0;
          mergeSnapshotIntoMemory(tools, snapshot);
          totalSessions += snapshot.totalSessions;
          // Baseline = what's on disk now. Saves compute their delta
          // against this so concurrent writers' increments survive.
          baselineSnapshot = snapshot;
          // Seed the committed-snapshot cache from disk so generateReport
          // can return historical signals immediately after a restart,
          // before any new save runs (#review-round34-F2). Without this
          // seed, a populated store loaded fresh would still report []
          // until the next dirty session committed.
          lastCommittedSnapshot = snapshot;
          hydrated = true;
          // Outage-era deltas (recorded before this successful load) must
          // be persisted even if the next session is otherwise clean. Without
          // this flag, the next onSessionEnd's `if (!state.dirty && !pendingPersist) return;`
          // would skip save and a process restart would drop the recovered
          // history. #review-round25-F1.
          if (hadOutageDeltas) pendingPersist = true;
        }
      } catch (e: unknown) {
        // Drop the rejected promise so the next session retries the load.
        loadPromise = undefined;
        onError?.(e);
      }
    }

    totalSessions += 1;
    sessionStates.set(ctx.sessionId, {
      sessionId: ctx.sessionId,
      sessionAvailableTools: new Set<string>(),
      sessionUsedTools: new Set<string>(),
      localTools: new Map<string, MutableToolRecord>(),
      inFlight: new Set<Promise<void>>(),
      cleanedUp: false,
      dirty: false,
    });
  }

  function getOrCreateLocalRecord(
    state: ToolAuditSessionState,
    toolName: string,
  ): MutableToolRecord {
    const existing = state.localTools.get(toolName);
    if (existing !== undefined) return existing;
    const record = createEmptyRecord(toolName);
    state.localTools.set(toolName, record);
    return record;
  }

  function recordToolOutcome(
    record: MutableToolRecord,
    latencyMs: number,
    endTime: number,
    success: boolean,
  ): void {
    if (success) {
      record.successCount += 1;
      record.lastUsedAt = endTime;
    } else {
      record.failureCount += 1;
    }
    record.totalLatencyMs += latencyMs;
    record.minLatencyMs = Math.min(record.minLatencyMs, latencyMs);
    record.maxLatencyMs = Math.max(record.maxLatencyMs, latencyMs);
  }

  async function wrapToolCall(
    ctx: TurnContext,
    request: ToolRequest,
    next: ToolHandler,
  ): Promise<ToolResponse> {
    const { toolId } = request;
    const state = sessionStates.get(ctx.session.sessionId);
    // Mutate session-local counters only — folded into global at session
    // end. Persists from concurrent sessions cannot capture in-flight
    // increments this way (#review-round27-F2). When state is missing
    // (defensive: should not happen since wrapToolCall runs inside a
    // session), fall back to the global aggregate to avoid losing the
    // count entirely.
    const record =
      state !== undefined ? getOrCreateLocalRecord(state, toolId) : getOrCreateRecord(toolId);
    record.callCount += 1;
    if (state) {
      state.sessionUsedTools.add(toolId);
      state.dirty = true;
    }

    const start = clock();
    // Track in-flight settlement so onSessionEnd can await all pending
    // outcomes before folding localTools into the global aggregate. Without
    // this, an early teardown (cancel/timeout/stream-failure) folds the
    // pre-await callCount and the post-await success/failure/latency
    // updates land on an orphaned record (#review-round36-F1).
    // let: assigned via the IIFE settler so we can register the awaitable.
    let settle: () => void = (): void => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    if (state) state.inFlight.add(settled);
    try {
      const response = await next(request);
      const endTime = clock();
      recordToolOutcome(record, endTime - start, endTime, true);
      return response;
    } catch (e: unknown) {
      const endTime = clock();
      recordToolOutcome(record, endTime - start, endTime, false);
      throw e;
    } finally {
      if (state) {
        state.inFlight.delete(settled);
        // Late completion after a session-end drain timeout: fold this
        // call's delta into the global aggregate and queue a persist so
        // the late outcome is durable instead of stranded on a deleted
        // session's local record (#review-round38-F1). When the last
        // in-flight settles, drop the session state entirely.
        if (state.cleanedUp) {
          foldLocalIntoGlobal(tools, state.localTools);
          if (state.inFlight.size === 0) sessionStates.delete(state.sessionId);
          void queueLatePersist();
        }
      }
      settle();
    }
  }

  function queueLatePersist(): Promise<void> {
    const previous = savePromise;
    savePromise = previous.then(async () => {
      try {
        const committed = await persistWithRetry();
        lastCommittedSnapshot = committed;
        pendingFailedPersist = false;
      } catch (e: unknown) {
        pendingFailedPersist = true;
        onError?.(e);
      }
    });
    return savePromise;
  }

  function recordAvailableTools(ctx: TurnContext, request: ModelRequest): void {
    if (request.tools === undefined) return;
    const state = sessionStates.get(ctx.session.sessionId);
    if (!state) return;
    for (const tool of request.tools) {
      state.sessionAvailableTools.add(tool.name);
    }
    state.dirty = true;
  }

  async function wrapModelCall(
    ctx: TurnContext,
    request: ModelRequest,
    next: ModelHandler,
  ): Promise<ModelResponse> {
    recordAvailableTools(ctx, request);
    return next(request);
  }

  function wrapModelStream(
    ctx: TurnContext,
    request: ModelRequest,
    next: ModelStreamHandler,
  ): AsyncIterable<ModelChunk> {
    recordAvailableTools(ctx, request);
    return next(request);
  }

  async function recordOnSessionEnd(ctx: SessionContext): Promise<void> {
    const state = sessionStates.get(ctx.sessionId);
    if (!state) return;

    // Wait for any tool calls still awaiting their outcome so the post-
    // await success/failure/latency updates land in localTools BEFORE we
    // fold and persist (#review-round36-F1). Bounded by drainTimeoutMs
    // so a hung tool on a dead dependency cannot wedge teardown
    // indefinitely (#review-round37-F1) — on timeout we fold the
    // partial state (started call without outcome) so the persisted
    // snapshot at least reflects the attempt.
    if (state.inFlight.size > 0) {
      // Snapshot before awaiting because each settler removes itself from
      // the set, mutating it during iteration.
      const drained = Promise.allSettled([...state.inFlight]);
      if (drainTimeoutMs === Number.POSITIVE_INFINITY) {
        await drained;
      } else {
        const timedOut = await Promise.race([
          drained.then(() => false as const),
          new Promise<true>((resolve) => setTimeout(() => resolve(true), drainTimeoutMs)),
        ]);
        if (timedOut) {
          onError?.(
            new Error(
              `tool-audit: session-end drain timed out after ${String(drainTimeoutMs)}ms with ${String(state.inFlight.size)} in-flight tool call(s); persisting partial state`,
            ),
          );
        }
      }
    }

    // Fold session-local tool counters into the shared aggregate now that
    // every call this session made has either completed or aborted. Until
    // this point the global `tools` map saw none of this session's
    // increments, so persists from concurrent sessions could not
    // accidentally commit our in-flight work (#review-round27-F2).
    foldLocalIntoGlobal(tools, state.localTools);

    for (const toolName of state.sessionAvailableTools) {
      getOrCreateRecord(toolName).sessionsAvailable += 1;
    }
    for (const toolName of state.sessionUsedTools) {
      getOrCreateRecord(toolName).sessionsUsed += 1;
    }

    // Defer cleanup if drain timed out with in-flight calls still
    // pending. Marking cleanedUp routes any late completion through the
    // late-fold path (wrapToolCall finally), which folds the new delta
    // into global and queues a follow-up persist instead of stranding
    // the outcome on a deleted session's local record
    // (#review-round38-F1).
    if (state.inFlight.size > 0) {
      state.cleanedUp = true;
    } else {
      sessionStates.delete(ctx.sessionId);
    }

    // Skip when this session contributed nothing AND no earlier
    // concurrent session left a deferred signal flush for us to drain
    // AND no prior persist failed (#review-round33-F1: a stranded
    // failed-save would otherwise wait indefinitely for the next dirty
    // session).
    if (!state.dirty && !pendingPersist && !pendingFailedPersist) return;

    // Defer persistence AND signal emission until hydration succeeds.
    // Without this guard, a transient store outage produced false
    // unused / low_adoption / high_failure signals from in-memory
    // counters that hadn't been merged with historical disk state
    // yet, and overwrites of disk with outage-local data
    // (#review-round24-F1). Deltas recorded during the outage are
    // NOT lost: they live in `tools` / `totalSessions` and merge
    // with the disk snapshot on the next successful load
    // (mergeSnapshotIntoMemory in onSessionStart).
    if (!hydrated) {
      if (state.dirty) pendingPersist = true;
      return;
    }

    const otherSessionsActive = sessionStates.size > 0;
    pendingPersist = otherSessionsActive;

    // Serialize saves so two concurrent session ends in this process can't
    // race each other. CRITICAL: the snapshot is built INSIDE the queued
    // closure (not at queue time) so each save diffs against the baseline
    // it actually runs against. A pre-built snapshot would miss any
    // adoptNewBaseline rebases performed by an earlier save in the chain
    // and could write stale (or negative) deltas, rolling back rival
    // writers' increments (#review-round30-F1). Cross-process safety:
    // loadAndMergeForSave does read-modify-write; saveIfVersion (CAS)
    // closes the multi-writer lost-update window (#review-round28-F1).
    const previous = savePromise;
    // let: snapshot the save closure committed; signals emit from it.
    let committedSnapshot: ToolAuditSnapshot | undefined;
    savePromise = previous.then(async () => {
      try {
        committedSnapshot = await persistWithRetry();
        lastCommittedSnapshot = committedSnapshot;
        pendingFailedPersist = false;
      } catch (e: unknown) {
        // Persist failed → keep the flag so the next session retries
        // even if it is otherwise clean (#review-round33-F1).
        pendingFailedPersist = true;
        onError?.(e);
      }
    });
    await savePromise;

    // Emit lifecycle signals ONLY after the snapshot is durably committed.
    // Pre-commit emission risks paging / auto-disable on state that never
    // hit disk; on restart the same signals would re-fire because the
    // baseline never advanced (#review-round29-F3). Defer when overlap is
    // active so partial counters don't trigger false signals.
    if (committedSnapshot !== undefined && !otherSessionsActive && onAuditResult !== undefined) {
      try {
        const signals = computeLifecycleSignals(committedSnapshot, validConfig);
        if (signals.length > 0) onAuditResult(signals);
      } catch (e: unknown) {
        onError?.(e);
      }
    }
  }

  /**
   * Persist with optional CAS retry. Builds the pending snapshot from
   * CURRENT in-memory state (after any earlier saves' rebases have
   * settled). On conflict, fold the rival writer's delta into the
   * in-memory `tools` map so our pending snapshot reflects BOTH our
   * work and theirs, then retry. Capped to avoid pathological livelock
   * under heavy contention. Returns the snapshot actually committed.
   */
  async function persistWithRetry(): Promise<ToolAuditSnapshot> {
    if (store.saveIfVersion === undefined) {
      const pending = buildSnapshot(tools, totalSessions, clock);
      const merged = await loadAndMergeForSave(pending);
      await store.save(merged);
      baselineSnapshot = merged;
      return merged;
    }
    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const pending = buildSnapshot(tools, totalSessions, clock);
      const merged = await loadAndMergeForSave(pending);
      const expectedVersion = baselineSnapshot.version ?? 0;
      const next: ToolAuditSnapshot = { ...merged, version: expectedVersion + 1 };
      const result = await store.saveIfVersion(next, expectedVersion);
      if (result.ok) {
        baselineSnapshot = next;
        return next;
      }
      adoptNewBaseline(result.current);
    }
    throw new Error(
      `tool-audit: saveIfVersion conflict not resolved after ${String(maxAttempts)} attempts`,
    );
  }

  /**
   * Adopt a freshly-observed disk snapshot as the new baseline, folding
   * the per-record delta (newBaseline − oldBaseline) into the in-memory
   * aggregate so our uncommitted local work is preserved relative to the
   * new baseline. Called on saveIfVersion conflict to incorporate the
   * rival writer's contribution before retrying.
   */
  function adoptNewBaseline(newBaseline: ToolAuditSnapshot): void {
    for (const [name, newRec] of Object.entries(newBaseline.tools)) {
      const oldRec = baselineSnapshot.tools[name];
      const inMem = tools.get(name) ?? createEmptyRecord(name);
      inMem.callCount += newRec.callCount - (oldRec?.callCount ?? 0);
      inMem.successCount += newRec.successCount - (oldRec?.successCount ?? 0);
      inMem.failureCount += newRec.failureCount - (oldRec?.failureCount ?? 0);
      inMem.totalLatencyMs += newRec.totalLatencyMs - (oldRec?.totalLatencyMs ?? 0);
      inMem.sessionsAvailable += newRec.sessionsAvailable - (oldRec?.sessionsAvailable ?? 0);
      inMem.sessionsUsed += newRec.sessionsUsed - (oldRec?.sessionsUsed ?? 0);
      inMem.lastUsedAt = Math.max(inMem.lastUsedAt, newRec.lastUsedAt);
      if (newRec.minLatencyMs > 0) {
        inMem.minLatencyMs = Math.min(inMem.minLatencyMs, newRec.minLatencyMs);
      }
      inMem.maxLatencyMs = Math.max(inMem.maxLatencyMs, newRec.maxLatencyMs);
      tools.set(name, inMem);
    }
    totalSessions += newBaseline.totalSessions - baselineSnapshot.totalSessions;
    baselineSnapshot = newBaseline;
  }

  function applyDelta(
    pending: ToolUsageRecord | undefined,
    base: ToolUsageRecord | undefined,
    disk: ToolUsageRecord | undefined,
    name: string,
  ): ToolUsageRecord | undefined {
    if (pending === undefined && disk === undefined) return undefined;
    const baseCount = base?.callCount ?? 0;
    const baseSuccess = base?.successCount ?? 0;
    const baseFailure = base?.failureCount ?? 0;
    const baseTotalLat = base?.totalLatencyMs ?? 0;
    const baseSessAvail = base?.sessionsAvailable ?? 0;
    const baseSessUsed = base?.sessionsUsed ?? 0;
    const callCount = (disk?.callCount ?? 0) + ((pending?.callCount ?? 0) - baseCount);
    const successCount = (disk?.successCount ?? 0) + ((pending?.successCount ?? 0) - baseSuccess);
    const failureCount = (disk?.failureCount ?? 0) + ((pending?.failureCount ?? 0) - baseFailure);
    const totalLatencyMs =
      (disk?.totalLatencyMs ?? 0) + ((pending?.totalLatencyMs ?? 0) - baseTotalLat);
    const sessionsAvailable =
      (disk?.sessionsAvailable ?? 0) + ((pending?.sessionsAvailable ?? 0) - baseSessAvail);
    const sessionsUsed = (disk?.sessionsUsed ?? 0) + ((pending?.sessionsUsed ?? 0) - baseSessUsed);
    const lastUsedAt = Math.max(disk?.lastUsedAt ?? 0, pending?.lastUsedAt ?? 0);
    const minA = pending?.minLatencyMs ?? 0;
    const minB = disk?.minLatencyMs ?? 0;
    const minLatencyMs = minA === 0 ? minB : minB === 0 ? minA : Math.min(minA, minB);
    const maxLatencyMs = Math.max(pending?.maxLatencyMs ?? 0, disk?.maxLatencyMs ?? 0);
    return {
      toolName: name,
      callCount,
      successCount,
      failureCount,
      lastUsedAt,
      avgLatencyMs: callCount > 0 ? totalLatencyMs / callCount : 0,
      minLatencyMs,
      maxLatencyMs,
      totalLatencyMs,
      sessionsAvailable,
      sessionsUsed,
    };
  }

  async function loadAndMergeForSave(
    pendingSnapshot: ToolAuditSnapshot,
  ): Promise<ToolAuditSnapshot> {
    // Re-read disk so we can detect concurrent writes from other writers.
    // If load throws, fall back to the in-memory snapshot — better than
    // skipping the save entirely.
    let onDisk: ToolAuditSnapshot | undefined;
    try {
      onDisk = await store.load();
    } catch (e: unknown) {
      onError?.(e);
      return pendingSnapshot;
    }

    // Baseline-delta merge: our in-memory state = baseline + our deltas.
    // The on-disk state may have advanced past baseline (another writer).
    // Final = disk + (pending - baseline). For each cumulative counter
    // (callCount, successCount, failureCount, totalLatencyMs, sessions*,
    // totalSessions) this preserves both writers' increments without
    // double-counting our own. Latency extremes (min/max) and lastUsedAt
    // are not additive — take the safe min/max of (disk, pending) which
    // both include the baseline.
    const mergedTools: Record<string, ToolUsageRecord> = {};
    const allNames = new Set<string>([
      ...Object.keys(pendingSnapshot.tools),
      ...Object.keys(onDisk.tools),
    ]);
    for (const name of allNames) {
      const merged = applyDelta(
        pendingSnapshot.tools[name],
        baselineSnapshot.tools[name],
        onDisk.tools[name],
        name,
      );
      if (merged !== undefined) mergedTools[name] = merged;
    }

    const totalSessionsDelta = pendingSnapshot.totalSessions - baselineSnapshot.totalSessions;
    return {
      tools: mergedTools,
      totalSessions: onDisk.totalSessions + totalSessionsDelta,
      lastUpdatedAt: Math.max(pendingSnapshot.lastUpdatedAt, onDisk.lastUpdatedAt),
    };
  }

  return {
    name: "koi:tool-audit",
    priority: 100,
    phase: "observe",
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => CAPABILITY_FRAGMENT,
    onSessionStart: recordOnSessionStart,
    onSessionEnd: recordOnSessionEnd,
    wrapModelCall,
    wrapModelStream,
    wrapToolCall,
    // Lifecycle signals must come from COMMITTED + HYDRATED state only.
    // The session-end path defers signal emission until overlap clears
    // and hydration succeeds because in-flight session counters without
    // finalized sessionsAvailable/sessionsUsed and outage-local in-memory
    // state produce false high_failure / low_adoption / unused signals
    // (#review-round24-F1, #review-round17-F1, #review-round18-F2). The
    // on-demand generateReport path must respect the same guards or
    // callers can page / auto-disable on bogus signals during overlap or
    // pre-hydration windows (#review-round28-F2). Always derived from
    // lastCommittedSnapshot (the most recent SUCCESSFUL persist) so a
    // pending or failed save cannot surface signals from state that
    // never reached disk (#review-round33-F3). Returns [] when not safe
    // to compute; callers wanting raw live stats should use getSnapshot.
    generateReport: (): readonly ToolAuditResult[] => {
      if (!hydrated || sessionStates.size > 0 || pendingFailedPersist) return [];
      return computeLifecycleSignals(lastCommittedSnapshot, validConfig);
    },
    getSnapshot: (): ToolAuditSnapshot => buildLiveSnapshot(),
  };

  /**
   * Snapshot view that includes BOTH the committed `tools` aggregate AND
   * in-flight per-session local counters. Persistence intentionally does
   * not use this — it only writes committed data (#review-round27-F2). But
   * runtime observability (getSnapshot) should reflect the full live
   * picture so callers can see active work. NOT used for lifecycle
   * signals — see generateReport for the committed-only signal path.
   */
  function buildLiveSnapshot(): ToolAuditSnapshot {
    if (sessionStates.size === 0) {
      return buildSnapshot(tools, totalSessions, clock);
    }
    const merged = new Map<string, MutableToolRecord>();
    for (const [name, rec] of tools) {
      merged.set(name, { ...rec });
    }
    for (const state of sessionStates.values()) {
      foldLocalIntoGlobal(merged, state.localTools);
    }
    return buildSnapshot(merged, totalSessions, clock);
  }
}
