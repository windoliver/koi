export interface DashboardClientAgentStatus {
  readonly agentId: string;
  readonly name: string;
  readonly state: string;
  readonly agentType: string;
  readonly model?: string | undefined;
  readonly channels: readonly string[];
  readonly turns: number;
  readonly tokenCount: number;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly childCount: number;
}

export interface DashboardClientSessionSummary {
  readonly sessionId: string;
  readonly agentId: string;
  readonly status: string;
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly startedAt: number;
  readonly endedAt?: number | undefined;
}

export interface DashboardClientMetricPoint {
  readonly name: string;
  readonly value: number;
  readonly timestampMs: number;
  readonly tags?: Readonly<Record<string, string>> | undefined;
}

export interface DashboardClientTraceSpan {
  readonly spanId: string;
  readonly name: string;
  readonly category: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly error?: string | undefined;
  readonly children: readonly DashboardClientTraceSpan[];
}

export interface DashboardClientTraceView {
  readonly turnId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly startedAtMs: number;
  readonly totalDurationMs: number;
  readonly root: DashboardClientTraceSpan;
}

export type AgentStatus = "running" | "idle" | "offline" | "error";
export type SessionStatus = "active" | "queued" | "completed" | "failed";
export type TraceStatus = "success" | "running" | "warning" | "error";
export type MetricTrend = "up" | "down" | "steady";

export interface DashboardMetric {
  label: string;
  value: string;
  detail: string;
  trend: MetricTrend;
  // Timestamp of the latest sample backing this metric. Used to keep mergeMetrics
  // monotonic when historical fetches and live SSE events race for the same label.
  timestampMs: number;
}

export interface DashboardTraceEntry {
  id: string;
  label: string;
  detail: string;
  timestamp: string;
  status: TraceStatus;
}

export interface DashboardSession {
  id: string;
  agentId: string;
  title: string;
  summary: string;
  status: SessionStatus;
  startedAt: string;
  updatedAt: string;
  durationMs: number;
  trace: DashboardTraceEntry[];
  metrics: DashboardMetric[];
}

export interface DashboardAgent {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  region: string;
  lastSeenAt: string;
}

export interface DashboardSnapshot {
  generatedAt: string;
  agents: DashboardAgent[];
  sessions: DashboardSession[];
}

export interface DashboardViewModel {
  generatedAt: string;
  agents: DashboardAgent[];
  sessionsById: Record<string, DashboardSession>;
  sessionsByAgentId: Record<string, DashboardSession[]>;
  selectedAgentId: string | null;
  selectedSessionId: string | null;
  visibleSessions: DashboardSession[];
  selectedSession: DashboardSession | null;
  // Traces are server-emitted with turnId+agentId only (no sessionId), so we cache them
  // by turnId and surface the latest turn per agent. This avoids guessing the target
  // session for agents with multiple sessions.
  tracesByTurnId: Record<string, DashboardTraceEntry[]>;
  // Tracks the most recent turn per agent. `startedAtMs` makes the pointer monotonic
  // so late-arriving historical hydration cannot roll the trace pane back.
  latestTurnByAgentId: Record<string, { readonly turnId: string; readonly startedAtMs: number }>;
  selectedAgentTrace: DashboardTraceEntry[];
  // Metric points received before their session.summary arrived. Drained when the
  // matching session is added so the new session does not lose its first samples
  // under SSE event ordering races.
  pendingMetricsBySessionId: Record<string, readonly DashboardClientMetricPoint[]>;
  isLoading: boolean;
  errorMessage: string | null;
}

export type DashboardEvent =
  | { type: "agent.selected"; agentId: string }
  | { type: "session.selected"; sessionId: string }
  | { type: "snapshot.loaded"; snapshot: DashboardSnapshot }
  | { type: "agent.status.received"; status: DashboardClientAgentStatus }
  | { type: "session.summary.received"; session: DashboardClientSessionSummary; nowMs?: number }
  | { type: "metric.received"; points: readonly DashboardClientMetricPoint[] }
  | { type: "trace.received"; trace: DashboardClientTraceView }
  | { type: "loading.set"; isLoading: boolean }
  | { type: "error.set"; message: string | null };

import { mapAgentSnapshot, mapSessionSnapshot, mapTraceView } from "./mappers.js";
import {
  applyMetricPointsToSession,
  createDashboardViewModel,
  createDerivedState,
  createEmptyDashboardViewModel,
  createViewModelState,
  PENDING_METRICS_PER_SESSION_LIMIT,
  replaceAgent,
  replaceSession,
} from "./view-model.js";

export { mapMetricPoints } from "./mappers.js";
export {
  createDashboardViewModel,
  createEmptyDashboardViewModel,
  mapAgentSnapshot,
  mapSessionSnapshot,
  mapTraceView,
};

export function applyDashboardEvent(
  state: DashboardViewModel,
  event: DashboardEvent,
): DashboardViewModel {
  switch (event.type) {
    case "agent.selected": {
      if (!state.agents.some((agent) => agent.id === event.agentId)) {
        return state;
      }

      return createDerivedState({
        ...state,
        selectedAgentId: event.agentId,
        selectedSessionId: state.sessionsByAgentId[event.agentId]?.[0]?.id ?? null,
      });
    }

    case "session.selected": {
      const session = state.sessionsById[event.sessionId];

      if (!session) {
        return state;
      }

      return createDerivedState({
        ...state,
        selectedAgentId: session.agentId,
        selectedSessionId: session.id,
      });
    }

    case "snapshot.loaded":
      return createViewModelState(event.snapshot, {
        isLoading: false,
        errorMessage: null,
        selectedAgentId: state.selectedAgentId,
        selectedSessionId: state.selectedSessionId,
        tracesByTurnId: state.tracesByTurnId,
        latestTurnByAgentId: state.latestTurnByAgentId,
        pendingMetricsBySessionId: state.pendingMetricsBySessionId,
      });

    case "agent.status.received": {
      const agent = mapAgentSnapshot(event.status);
      const nextState = replaceAgent(state, agent);
      return createDerivedState({
        ...nextState,
        generatedAt: new Date(event.status.lastActivityAt).toISOString(),
      });
    }

    case "session.summary.received": {
      const previousSession = state.sessionsById[event.session.sessionId];
      const isNewSession = previousSession === undefined;
      const nextSession = mapSessionSnapshot(event.session, event.nowMs);
      const mergedSession = previousSession
        ? {
            ...nextSession,
            metrics: previousSession.metrics,
            trace: previousSession.trace,
          }
        : nextSession;

      let nextState = replaceSession(
        createDerivedState({
          ...state,
          generatedAt: new Date(event.session.endedAt ?? event.nowMs ?? Date.now()).toISOString(),
        }),
        mergedSession,
      );

      // Drain any metric points that arrived before this session's summary.
      // Without this, an SSE ordering race (metric event delivered before
      // session-summary) would silently lose the new session's first samples.
      if (isNewSession) {
        const pendingPoints = state.pendingMetricsBySessionId[event.session.sessionId];
        if (pendingPoints && pendingPoints.length > 0) {
          nextState = applyMetricPointsToSession(nextState, event.session.sessionId, pendingPoints);
          const { [event.session.sessionId]: _drained, ...remainingPending } =
            nextState.pendingMetricsBySessionId;
          nextState = createDerivedState({
            ...nextState,
            pendingMetricsBySessionId: remainingPending,
          });
        }
      }
      return nextState;
    }

    case "metric.received": {
      const pointsBySessionId = new Map<string, DashboardClientMetricPoint[]>();

      for (const point of event.points) {
        // Route only by an explicit sessionId tag. The agentId fallback used to guess
        // a session when an agent had multiple, which corrupted per-session metrics
        // and updatedAt for the wrong card.
        const sessionId = point.tags?.sessionId ?? null;
        if (sessionId === null) continue;
        const existingPoints = pointsBySessionId.get(sessionId) ?? [];
        existingPoints.push(point);
        pointsBySessionId.set(sessionId, existingPoints);
      }

      let nextState = state;
      let nextPending = state.pendingMetricsBySessionId;
      for (const [sessionId, points] of pointsBySessionId) {
        const existingSession = nextState.sessionsById[sessionId];
        if (existingSession) {
          nextState = applyMetricPointsToSession(nextState, sessionId, points);
        } else {
          // Session not yet seen. Buffer points by sessionId so they apply once
          // session.summary.received arrives. Bound the buffer per session to
          // avoid an unbounded memory leak when a session-summary is never sent.
          const previous = nextPending[sessionId] ?? [];
          const merged = [...previous, ...points];
          const bounded =
            merged.length > PENDING_METRICS_PER_SESSION_LIMIT
              ? merged.slice(merged.length - PENDING_METRICS_PER_SESSION_LIMIT)
              : merged;
          nextPending = { ...nextPending, [sessionId]: bounded };
        }
      }
      if (nextPending !== state.pendingMetricsBySessionId) {
        nextState = createDerivedState({
          ...nextState,
          pendingMetricsBySessionId: nextPending,
        });
      }
      return nextState;
    }

    case "trace.received": {
      // Trace events carry (turnId, agentId) but no sessionId, so we cache traces by
      // turnId and surface them at agent scope. The "latest turn per agent" pointer
      // is monotonic in startedAtMs so late-arriving historical hydration cannot
      // roll back the agent's trace pane to an older turn.
      const tracesByTurnId = {
        ...state.tracesByTurnId,
        [event.trace.turnId]: mapTraceView(event.trace),
      };
      const incoming = { turnId: event.trace.turnId, startedAtMs: event.trace.startedAtMs };
      const current = state.latestTurnByAgentId[event.trace.agentId];
      const shouldAdvance =
        current === undefined ||
        current.turnId === incoming.turnId ||
        incoming.startedAtMs >= current.startedAtMs;
      const latestTurnByAgentId = shouldAdvance
        ? { ...state.latestTurnByAgentId, [event.trace.agentId]: incoming }
        : state.latestTurnByAgentId;
      return createDerivedState({
        ...state,
        tracesByTurnId,
        latestTurnByAgentId,
      });
    }

    case "loading.set":
      return createDerivedState({
        ...state,
        isLoading: event.isLoading,
      });

    case "error.set":
      return createDerivedState({
        ...state,
        errorMessage: event.message,
      });
  }
}
