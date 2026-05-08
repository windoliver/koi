import type { AgentId, KoiError, Result, SessionId } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type {
  AgentListQuery,
  DashboardDataSource,
  MetricListQuery,
  Page,
  SessionListQuery,
  TraceListQuery,
} from "@koi/dashboard-api";
import type {
  AgentStatus,
  MetricPoint,
  SessionSummary,
  TraceView,
  WsEvent,
} from "@koi/dashboard-types";

export interface FixtureControls {
  readonly source: DashboardDataSource;
  readonly emit: (event: WsEvent) => void;
  readonly setAgents: (agents: readonly AgentStatus[]) => void;
  readonly setSessions: (sessions: readonly SessionSummary[]) => void;
  readonly setMetrics: (points: readonly MetricPoint[]) => void;
  readonly setTraces: (traces: readonly TraceView[]) => void;
  readonly failNext: (
    method:
      | "listAgents"
      | "listSessions"
      | "listMetrics"
      | "listTraces"
      | "getAgent"
      | "getSession"
      | "getTrace",
  ) => void;
  readonly failMetricsForName: (name: string) => void;
  readonly clearFailures: () => void;
}

const PAGE_SIZE = 25;

export function createPaginatedFixtureSource(): FixtureControls {
  let agents: readonly AgentStatus[] = [];
  let sessions: readonly SessionSummary[] = [];
  let metrics: readonly MetricPoint[] = [];
  let traces: readonly TraceView[] = [];
  const subs = new Set<(e: WsEvent) => void>();
  const oneShotFailures = new Set<string>();
  const failingMetricNames = new Set<string>();

  const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value });
  const failOnce = <T>(name: string): Result<T, KoiError> | null => {
    if (!oneShotFailures.has(name)) return null;
    oneShotFailures.delete(name);
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `injected failure for ${name}`,
        retryable: RETRYABLE_DEFAULTS.INTERNAL,
      },
    };
  };

  function paginate<T>(items: readonly T[], cursor: string | undefined, limit: number): Page<T> {
    const start = cursor ? Number.parseInt(cursor, 10) : 0;
    const end = Math.min(items.length, start + Math.min(limit, PAGE_SIZE));
    const slice = items.slice(start, end);
    const nextCursor = end < items.length ? String(end) : undefined;
    return nextCursor !== undefined ? { items: slice, nextCursor } : { items: slice };
  }

  const source: DashboardDataSource = {
    listAgents(query: AgentListQuery): Result<Page<AgentStatus>, KoiError> {
      const fail = failOnce<Page<AgentStatus>>("listAgents");
      if (fail) return fail;
      const filtered =
        query.state === undefined ? agents : agents.filter((a) => a.state === query.state);
      return ok(paginate(filtered, query.cursor, query.limit));
    },
    getAgent(id: AgentId): Result<AgentStatus | undefined, KoiError> {
      const fail = failOnce<AgentStatus | undefined>("getAgent");
      if (fail) return fail;
      return ok(agents.find((a) => a.agentId === id));
    },
    terminateAgent(id: AgentId): Result<boolean, KoiError> {
      return ok(agents.some((a) => a.agentId === id));
    },
    listSessions(query: SessionListQuery): Result<Page<SessionSummary>, KoiError> {
      const fail = failOnce<Page<SessionSummary>>("listSessions");
      if (fail) return fail;
      let filtered = sessions;
      if (query.agentId !== undefined) {
        filtered = filtered.filter((s) => s.agentId === query.agentId);
      }
      if (query.status !== undefined) {
        filtered = filtered.filter((s) => s.status === query.status);
      }
      return ok(paginate(filtered, query.cursor, query.limit));
    },
    getSession(id: SessionId): Result<SessionSummary | undefined, KoiError> {
      return ok(sessions.find((s) => s.sessionId === id));
    },
    listMetrics(query: MetricListQuery): Result<readonly MetricPoint[], KoiError> {
      const fail = failOnce<readonly MetricPoint[]>("listMetrics");
      if (fail) return fail;
      if (query.name !== undefined && failingMetricNames.has(query.name)) {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: `injected failure for metric '${query.name}'`,
            retryable: RETRYABLE_DEFAULTS.INTERNAL,
          },
        };
      }
      let filtered = metrics;
      if (query.name !== undefined) filtered = filtered.filter((m) => m.name === query.name);
      if (query.sinceMs !== undefined) {
        const since = query.sinceMs;
        filtered = filtered.filter((m) => m.timestampMs >= since);
      }
      return ok(filtered.slice(0, query.limit));
    },
    listTraces(query: TraceListQuery): Result<Page<TraceView>, KoiError> {
      const fail = failOnce<Page<TraceView>>("listTraces");
      if (fail) return fail;
      let filtered = traces;
      if (query.agentId !== undefined) {
        filtered = filtered.filter((t) => t.agentId === query.agentId);
      }
      if (query.sinceMs !== undefined) {
        const since = query.sinceMs;
        filtered = filtered.filter((t) => t.startedAtMs >= since);
      }
      return ok(paginate(filtered, query.cursor, query.limit));
    },
    getTrace(id: string): Result<TraceView | undefined, KoiError> {
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
    emit: (event: WsEvent): void => {
      for (const cb of subs) cb(event);
    },
    setAgents: (next): void => {
      agents = next;
    },
    setSessions: (next): void => {
      sessions = next;
    },
    setMetrics: (next): void => {
      metrics = next;
    },
    setTraces: (next): void => {
      traces = next;
    },
    failNext: (method): void => {
      oneShotFailures.add(method);
    },
    failMetricsForName: (name): void => {
      failingMetricNames.add(name);
    },
    clearFailures: (): void => {
      oneShotFailures.clear();
      failingMetricNames.clear();
    },
  };
}
