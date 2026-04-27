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
  readonly sessionAvailableTools: Set<string>;
  readonly sessionUsedTools: Set<string>;
  /**
   * Per-session call/latency counters. Kept ISOLATED from the global
   * `tools` aggregate until onSessionEnd so concurrent persists from
   * other sessions cannot capture this session's in-flight work
   * (started calls without outcomes, or work that may later abort).
   * #review-round27-F2.
   */
  readonly localTools: Map<string, MutableToolRecord>;
  dirty: boolean;
}

/** Fold session-local counters into the shared aggregate. Sums counters,
 * mins/maxes latency extremes, takes the larger lastUsedAt. */
function foldLocalIntoGlobal(
  global: Map<string, MutableToolRecord>,
  local: Map<string, MutableToolRecord>,
): void {
  for (const [name, l] of local) {
    const g = global.get(name);
    if (g === undefined) {
      global.set(name, { ...l });
      continue;
    }
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
      sessionAvailableTools: new Set<string>(),
      sessionUsedTools: new Set<string>(),
      localTools: new Map<string, MutableToolRecord>(),
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
    try {
      const response = await next(request);
      const endTime = clock();
      recordToolOutcome(record, endTime - start, endTime, true);
      return response;
    } catch (e: unknown) {
      const endTime = clock();
      recordToolOutcome(record, endTime - start, endTime, false);
      throw e;
    }
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

    sessionStates.delete(ctx.sessionId);

    // Skip when this session contributed nothing AND no earlier
    // concurrent session left a deferred signal flush for us to drain.
    if (!state.dirty && !pendingPersist) return;

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

    const snapshot = buildSnapshot(tools, totalSessions, clock);
    const otherSessionsActive = sessionStates.size > 0;

    // Defer signal emission while OTHER sessions are still active. The
    // shared `tools` map contains in-flight call counts / latencies from
    // those sessions but their sessionsAvailable / sessionsUsed counters
    // have not been folded in yet, so lifecycle signals computed now
    // would falsely flag tools as high_failure / low_adoption during
    // overlap windows and trigger downstream pages or auto-disable
    // (#review-round17-F1, #review-round18-F2). The last completing
    // session in the active set drains the deferred signal.
    // PERSISTENCE intentionally does NOT defer here: a long-lived or
    // stuck session blocking flushes process-wide meant a crash/redeploy
    // before the active set drained lost ALL completed-session counters
    // (#review-round26-F2). loadAndMergeForSave's read-modify-write
    // makes overlapping persists safe for in-flight counters.
    if (!otherSessionsActive && onAuditResult !== undefined) {
      // Observe-phase telemetry must never abort session teardown — a
      // throwing sink would otherwise reject onSessionEnd and skip the
      // store.save below, leaving the snapshot unpersisted. Route any
      // callback failure through onError and continue with persistence.
      try {
        const signals = computeLifecycleSignals(snapshot, validConfig);
        if (signals.length > 0) onAuditResult(signals);
      } catch (e: unknown) {
        onError?.(e);
      }
    }
    // Mark for the next session to drain signals if overlap suppressed
    // emission this round; clear otherwise.
    pendingPersist = otherSessionsActive;

    // Serialize saves so two concurrent session ends in this process can't
    // race each other. Across PROCESSES sharing one ToolAuditStore, we
    // additionally re-load before saving and merge any new disk state into
    // the snapshot we're about to write — converting the raw load/save
    // contract into an at-least-once read-modify-write. This narrows
    // (though does not eliminate, absent CAS at the store layer) the
    // multi-writer lost-update window. Stores that need stronger
    // guarantees should provide their own versioned save.
    const previous = savePromise;
    savePromise = previous.then(async () => {
      try {
        const merged = await loadAndMergeForSave(snapshot);
        await store.save(merged);
        // Successful save — advance the baseline so the next save's
        // delta is computed against what's now on disk.
        baselineSnapshot = merged;
      } catch (e: unknown) {
        onError?.(e);
      }
    });
    await savePromise;
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
    generateReport: (): readonly ToolAuditResult[] =>
      computeLifecycleSignals(buildLiveSnapshot(), validConfig),
    getSnapshot: (): ToolAuditSnapshot => buildLiveSnapshot(),
  };

  /**
   * Snapshot view that includes BOTH the committed `tools` aggregate AND
   * in-flight per-session local counters. Persistence intentionally does
   * not use this — it only writes committed data (#review-round27-F2). But
   * runtime observability (getSnapshot, generateReport) should reflect
   * the full live picture so callers can see active work.
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
