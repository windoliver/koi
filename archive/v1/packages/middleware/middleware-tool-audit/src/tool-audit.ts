/**
 * Tool audit middleware — tracks tool usage and emits lifecycle signals.
 *
 * Observes tool availability via wrapModelCall, records call outcomes via
 * wrapToolCall, and computes lifecycle signals on session end.
 *
 * Priority 100: outermost layer, sees all tool call attempts.
 */

import type {
  CapabilityFragment,
  ModelHandler,
  ModelRequest,
  ModelResponse,
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

/** Mutable internal record used inside the closure. */
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
    load: () => stored,
    save: (snapshot) => {
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

/** Creates tool audit middleware that tracks usage and emits lifecycle signals. */
export function createToolAuditMiddleware(config: ToolAuditConfig): ToolAuditMiddleware {
  const store = config.store ?? createFallbackStore();
  const clock = config.clock ?? Date.now;
  const { onAuditResult, onError } = config;

  const tools = new Map<string, MutableToolRecord>();
  const sessionStates = new Map<string, ToolAuditSessionState>();
  // let: lazy init cache for first load
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

  const capabilityFragment: CapabilityFragment = {
    label: "tool-audit",
    description: "Tool usage tracking and lifecycle signals active",
  };

  return {
    name: "koi:tool-audit",
    priority: 100,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      try {
        // Lazy load: concurrent first sessions share the same promise
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
      sessionStates.set(ctx.sessionId as string, {
        sessionAvailableTools: new Set<string>(),
        sessionUsedTools: new Set<string>(),
        dirty: false,
      });
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      if (request.tools !== undefined) {
        const state = sessionStates.get(ctx.session.sessionId as string);
        if (state) {
          for (const tool of request.tools) {
            state.sessionAvailableTools.add(tool.name);
          }
          state.dirty = true;
        }
      }
      return next(request);
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const { toolId } = request;
      const record = getOrCreateRecord(toolId);
      record.callCount += 1;
      const state = sessionStates.get(ctx.session.sessionId as string);
      if (state) {
        state.sessionUsedTools.add(toolId);
        state.dirty = true;
      }

      const start = clock();
      // let: assigned inside try block, used after it (deferred init pattern)
      let response: ToolResponse;
      try {
        response = await next(request);
      } catch (e: unknown) {
        const latencyMs = clock() - start;
        record.failureCount += 1;
        record.totalLatencyMs += latencyMs;
        record.minLatencyMs = Math.min(record.minLatencyMs, latencyMs);
        record.maxLatencyMs = Math.max(record.maxLatencyMs, latencyMs);
        throw e;
      }

      const endTime = clock();
      const latencyMs = endTime - start;
      record.successCount += 1;
      record.lastUsedAt = endTime;
      record.totalLatencyMs += latencyMs;
      record.minLatencyMs = Math.min(record.minLatencyMs, latencyMs);
      record.maxLatencyMs = Math.max(record.maxLatencyMs, latencyMs);

      return response;
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const state = sessionStates.get(ctx.sessionId as string);
      if (!state) return;

      for (const toolName of state.sessionAvailableTools) {
        getOrCreateRecord(toolName).sessionsAvailable += 1;
      }
      for (const toolName of state.sessionUsedTools) {
        getOrCreateRecord(toolName).sessionsUsed += 1;
      }

      sessionStates.delete(ctx.sessionId as string);

      if (!state.dirty) return;

      const snapshot = buildSnapshot(tools, totalSessions, clock);

      if (onAuditResult !== undefined) {
        const signals = computeLifecycleSignals(snapshot, config);
        if (signals.length > 0) {
          onAuditResult(signals);
        }
      }

      try {
        await store.save(snapshot);
      } catch (e: unknown) {
        onError?.(e);
      }
    },

    generateReport(): readonly ToolAuditResult[] {
      const snapshot = buildSnapshot(tools, totalSessions, clock);
      return computeLifecycleSignals(snapshot, config);
    },

    getSnapshot(): ToolAuditSnapshot {
      return buildSnapshot(tools, totalSessions, clock);
    },
  };
}
