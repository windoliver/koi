export type AgentStatus = "running" | "idle" | "offline" | "error";
export type SessionStatus = "active" | "queued" | "completed" | "failed";
export type TraceStatus = "success" | "running" | "warning" | "error";
export type MetricTrend = "up" | "down" | "steady";

export interface DashboardMetric {
  label: string;
  value: string;
  detail: string;
  trend: MetricTrend;
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
  isLoading: boolean;
  errorMessage: string | null;
}

export type DashboardEvent =
  | { type: "agent.selected"; agentId: string }
  | { type: "session.selected"; sessionId: string }
  | { type: "loading.set"; isLoading: boolean }
  | { type: "error.set"; message: string | null };

function sortSessionsByUpdatedAt(sessions: DashboardSession[]): DashboardSession[] {
  return [...sessions].sort((left, right) => {
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

function buildSessionsByAgentId(sessions: DashboardSession[]): Record<string, DashboardSession[]> {
  return sessions.reduce<Record<string, DashboardSession[]>>((accumulator, session) => {
    const existingSessions = accumulator[session.agentId] ?? [];
    accumulator[session.agentId] = [...existingSessions, session];
    return accumulator;
  }, {});
}

function buildSessionsById(sessions: DashboardSession[]): Record<string, DashboardSession> {
  return Object.fromEntries(sessions.map((session) => [session.id, session]));
}

function createDerivedState(
  baseState: Omit<DashboardViewModel, "visibleSessions" | "selectedSession">,
): DashboardViewModel {
  const visibleSessions = baseState.selectedAgentId
    ? sortSessionsByUpdatedAt(baseState.sessionsByAgentId[baseState.selectedAgentId] ?? [])
    : [];
  const selectedSession = baseState.selectedSessionId
    ? (baseState.sessionsById[baseState.selectedSessionId] ?? null)
    : null;

  return {
    ...baseState,
    visibleSessions,
    selectedSession,
  };
}

export function createDashboardViewModel(snapshot: DashboardSnapshot): DashboardViewModel {
  const sessionsByAgentId = Object.fromEntries(
    Object.entries(buildSessionsByAgentId(snapshot.sessions)).map(([agentId, sessions]) => [
      agentId,
      sortSessionsByUpdatedAt(sessions),
    ]),
  );
  const agents = [...snapshot.agents];
  const firstAgentId = agents[0]?.id ?? null;
  const firstSessionId = firstAgentId ? (sessionsByAgentId[firstAgentId]?.[0]?.id ?? null) : null;

  return createDerivedState({
    generatedAt: snapshot.generatedAt,
    agents,
    sessionsById: buildSessionsById(snapshot.sessions),
    sessionsByAgentId,
    selectedAgentId: firstAgentId,
    selectedSessionId: firstSessionId,
    isLoading: false,
    errorMessage: null,
  });
}

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
