import type { AgentId, SessionId } from "@koi/core";
import { agentId, sessionId } from "@koi/core";
import type {
  AgentStatus,
  MetricPoint,
  SessionSummary,
  TraceView,
  WsEvent,
} from "@koi/dashboard-types";

import type {
  AgentListQuery,
  DashboardDataSource,
  MetricListQuery,
  Page,
  SessionListQuery,
  TraceListQuery,
} from "./types.js";

/**
 * Builds an in-memory data source preloaded with deterministic fixtures.
 * Test code can override individual methods.
 */
export interface FixtureControls {
  readonly source: DashboardDataSource;
  readonly emit: (event: WsEvent) => void;
  readonly subscribers: () => number;
  readonly setAgents: (agents: readonly AgentStatus[]) => void;
  readonly setSessions: (sessions: readonly SessionSummary[]) => void;
  readonly setMetrics: (points: readonly MetricPoint[]) => void;
  readonly setTraces: (traces: readonly TraceView[]) => void;
  readonly terminatedAgents: ReadonlySet<string>;
}

export function createFixtureSource(): FixtureControls {
  let agents: readonly AgentStatus[] = [];
  let sessions: readonly SessionSummary[] = [];
  let metrics: readonly MetricPoint[] = [];
  let traces: readonly TraceView[] = [];
  const terminated = new Set<string>();
  const subs = new Set<(e: WsEvent) => void>();

  const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value });

  const source: DashboardDataSource = {
    listAgents(query: AgentListQuery) {
      const filtered =
        query.state === undefined ? agents : agents.filter((a) => a.state === query.state);
      return ok<Page<AgentStatus>>({ items: filtered.slice(0, query.limit) });
    },
    getAgent(id: AgentId) {
      return ok(agents.find((a) => a.agentId === id));
    },
    terminateAgent(id: AgentId) {
      const exists = agents.some((a) => a.agentId === id);
      if (exists) terminated.add(String(id));
      return ok(exists);
    },
    listSessions(query: SessionListQuery) {
      let filtered = sessions;
      if (query.agentId !== undefined) {
        filtered = filtered.filter((s) => s.agentId === query.agentId);
      }
      if (query.status !== undefined) {
        filtered = filtered.filter((s) => s.status === query.status);
      }
      return ok<Page<SessionSummary>>({ items: filtered.slice(0, query.limit) });
    },
    getSession(id: SessionId) {
      return ok(sessions.find((s) => s.sessionId === id));
    },
    listMetrics(query: MetricListQuery) {
      let filtered = metrics;
      if (query.name !== undefined) {
        filtered = filtered.filter((m) => m.name === query.name);
      }
      if (query.sinceMs !== undefined) {
        const since = query.sinceMs;
        filtered = filtered.filter((m) => m.timestampMs >= since);
      }
      return ok<readonly MetricPoint[]>(filtered.slice(0, query.limit));
    },
    listTraces(query: TraceListQuery) {
      let filtered = traces;
      if (query.agentId !== undefined) {
        filtered = filtered.filter((t) => t.agentId === query.agentId);
      }
      if (query.sinceMs !== undefined) {
        const since = query.sinceMs;
        filtered = filtered.filter((t) => t.startedAtMs >= since);
      }
      return ok<Page<TraceView>>({ items: filtered.slice(0, query.limit) });
    },
    getTrace(id: string) {
      return ok(traces.find((t) => t.turnId === id));
    },
    subscribe(callback: (event: WsEvent) => void): () => void {
      subs.add(callback);
      return () => {
        subs.delete(callback);
      };
    },
  };

  return {
    source,
    emit: (event) => {
      for (const cb of subs) cb(event);
    },
    subscribers: () => subs.size,
    setAgents: (next) => {
      agents = next;
    },
    setSessions: (next) => {
      sessions = next;
    },
    setMetrics: (next) => {
      metrics = next;
    },
    setTraces: (next) => {
      traces = next;
    },
    terminatedAgents: terminated,
  };
}

export function makeAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    agentId: agentId("ag-1"),
    name: "test agent",
    state: "running",
    agentType: "worker",
    channels: [],
    turns: 1,
    tokenCount: 100,
    startedAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    childCount: 0,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: sessionId("sess-1"),
    agentId: agentId("ag-1"),
    status: "active",
    turns: 2,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: -1,
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeMetric(overrides: Partial<MetricPoint> = {}): MetricPoint {
  return {
    name: "agent.tokens",
    value: 42,
    timestampMs: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeTrace(overrides: Partial<TraceView> = {}): TraceView {
  return {
    turnId: "turn-1",
    agentId: agentId("ag-1"),
    turnIndex: 0,
    startedAtMs: 1_700_000_000_000,
    totalDurationMs: 100,
    root: {
      spanId: "root",
      name: "turn",
      category: "custom",
      startedAtMs: 1_700_000_000_000,
      durationMs: 100,
      children: [],
    },
    ...overrides,
  };
}
