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

function hydrateFromSnapshot(
  tools: Map<string, MutableToolRecord>,
  snapshot: ToolAuditSnapshot,
): void {
  for (const [name, record] of Object.entries(snapshot.tools)) {
    tools.set(name, {
      toolName: record.toolName,
      callCount: record.callCount,
      successCount: record.successCount,
      failureCount: record.failureCount,
      lastUsedAt: record.lastUsedAt,
      totalLatencyMs: record.totalLatencyMs,
      minLatencyMs: record.minLatencyMs === 0 ? Number.POSITIVE_INFINITY : record.minLatencyMs,
      maxLatencyMs: record.maxLatencyMs,
      sessionsAvailable: record.sessionsAvailable,
      sessionsUsed: record.sessionsUsed,
    });
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
  // let: lazy init cache for first load — concurrent first sessions share the promise
  let loadPromise: Promise<ToolAuditSnapshot> | undefined;
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
    try {
      loadPromise ??= Promise.resolve(store.load());
      const snapshot = await loadPromise;
      if (tools.size === 0) {
        hydrateFromSnapshot(tools, snapshot);
        totalSessions = snapshot.totalSessions;
      }
    } catch (e: unknown) {
      onError?.(e);
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

    try {
      await store.save(snapshot);
    } catch (e: unknown) {
      onError?.(e);
    }
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
