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
import type { ToolAuditConfig } from "./config.js";
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
  dirty: boolean;
}

const CAPABILITY_FRAGMENT: CapabilityFragment = {
  label: "tool-audit",
  description: "Tool usage tracking and lifecycle signals active",
};

/** Creates tool audit middleware that tracks usage and emits lifecycle signals. */
export function createToolAuditMiddleware(config: ToolAuditConfig): ToolAuditMiddleware {
  const store = config.store ?? createFallbackStore();
  const clock = config.clock ?? Date.now;
  const { onAuditResult, onError } = config;

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
          mergeSnapshotIntoMemory(tools, snapshot);
          totalSessions += snapshot.totalSessions;
          hydrated = true;
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
      dirty: false,
    });
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
    const record = getOrCreateRecord(toolId);
    record.callCount += 1;
    const state = sessionStates.get(ctx.session.sessionId);
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

    for (const toolName of state.sessionAvailableTools) {
      getOrCreateRecord(toolName).sessionsAvailable += 1;
    }
    for (const toolName of state.sessionUsedTools) {
      getOrCreateRecord(toolName).sessionsUsed += 1;
    }

    sessionStates.delete(ctx.sessionId);

    if (!state.dirty) return;

    const snapshot = buildSnapshot(tools, totalSessions, clock);

    if (onAuditResult !== undefined) {
      const signals = computeLifecycleSignals(snapshot, config);
      if (signals.length > 0) onAuditResult(signals);
    }

    // Defer persistence until hydration succeeds so we don't overwrite
    // disk history with a memory-only partial snapshot. The deltas
    // recorded during the outage are NOT lost: they live in `tools` /
    // `totalSessions` and will be merged with the disk snapshot on the
    // next successful load (see mergeSnapshotIntoMemory in
    // recordOnSessionStart).
    if (!hydrated) return;

    // Serialize saves: each call awaits the prior save's settlement before
    // invoking store.save. Prevents two concurrent session ends from racing
    // and letting a stale snapshot land after a newer one. The chain
    // recovers from individual failures (per-call try/catch).
    const previous = savePromise;
    savePromise = previous.then(async () => {
      try {
        await store.save(snapshot);
      } catch (e: unknown) {
        onError?.(e);
      }
    });
    await savePromise;
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
      computeLifecycleSignals(buildSnapshot(tools, totalSessions, clock), config),
    getSnapshot: (): ToolAuditSnapshot => buildSnapshot(tools, totalSessions, clock),
  };
}
