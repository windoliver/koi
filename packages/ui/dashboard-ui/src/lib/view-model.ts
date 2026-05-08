import { mapMetricPoints } from "./mappers.js";
import type {
  DashboardAgent,
  DashboardClientMetricPoint,
  DashboardMetric,
  DashboardSession,
  DashboardSnapshot,
  DashboardTraceEntry,
  DashboardViewModel,
} from "./state.js";

// Per-session ceiling on buffered orphan metric points. Bounds memory if a
// session-summary never arrives for a given sessionId (misbehaving backend).
export const PENDING_METRICS_PER_SESSION_LIMIT = 1000;

export function sortSessionsByUpdatedAt(sessions: DashboardSession[]): DashboardSession[] {
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

type DerivedFreeBase = Omit<
  DashboardViewModel,
  "visibleSessions" | "selectedSession" | "selectedAgentTrace"
>;

export function createDerivedState(baseState: DerivedFreeBase): DashboardViewModel {
  const visibleSessions = baseState.selectedAgentId
    ? sortSessionsByUpdatedAt(baseState.sessionsByAgentId[baseState.selectedAgentId] ?? [])
    : [];
  const selectedSession = baseState.selectedSessionId
    ? (baseState.sessionsById[baseState.selectedSessionId] ?? null)
    : null;
  const latestTurn = baseState.selectedAgentId
    ? baseState.latestTurnByAgentId[baseState.selectedAgentId]
    : undefined;
  const selectedAgentTrace = latestTurn ? (baseState.tracesByTurnId[latestTurn.turnId] ?? []) : [];

  return {
    ...baseState,
    visibleSessions,
    selectedSession,
    selectedAgentTrace,
  };
}

export function createViewModelState(
  snapshot: DashboardSnapshot,
  options?: {
    readonly isLoading?: boolean;
    readonly errorMessage?: string | null;
    readonly selectedAgentId?: string | null;
    readonly selectedSessionId?: string | null;
    readonly tracesByTurnId?: Record<string, DashboardTraceEntry[]>;
    readonly latestTurnByAgentId?: Record<
      string,
      { readonly turnId: string; readonly startedAtMs: number }
    >;
    readonly pendingMetricsBySessionId?: Record<string, readonly DashboardClientMetricPoint[]>;
  },
): DashboardViewModel {
  const sessionsByAgentId = Object.fromEntries(
    Object.entries(buildSessionsByAgentId(snapshot.sessions)).map(([agentId, sessions]) => [
      agentId,
      sortSessionsByUpdatedAt(sessions),
    ]),
  );
  const agents = [...snapshot.agents];
  const requestedAgentId =
    options?.selectedAgentId && agents.some((agent) => agent.id === options.selectedAgentId)
      ? options.selectedAgentId
      : null;
  const firstAgentId = requestedAgentId ?? agents[0]?.id ?? null;
  const requestedSessionId =
    options?.selectedSessionId &&
    snapshot.sessions.some((session) => session.id === options.selectedSessionId)
      ? options.selectedSessionId
      : null;
  const firstSessionId =
    requestedSessionId ??
    (firstAgentId ? (sessionsByAgentId[firstAgentId]?.[0]?.id ?? null) : null);

  return createDerivedState({
    generatedAt: snapshot.generatedAt,
    agents,
    sessionsById: buildSessionsById(snapshot.sessions),
    sessionsByAgentId,
    selectedAgentId: firstAgentId,
    selectedSessionId: firstSessionId,
    tracesByTurnId: options?.tracesByTurnId ?? {},
    latestTurnByAgentId: options?.latestTurnByAgentId ?? {},
    pendingMetricsBySessionId: options?.pendingMetricsBySessionId ?? {},
    isLoading: options?.isLoading ?? false,
    errorMessage: options?.errorMessage ?? null,
  });
}

export function createDashboardViewModel(snapshot: DashboardSnapshot): DashboardViewModel {
  return createViewModelState(snapshot);
}

export function createEmptyDashboardViewModel(): DashboardViewModel {
  return createViewModelState(
    {
      generatedAt: new Date(0).toISOString(),
      agents: [],
      sessions: [],
    },
    {
      isLoading: true,
      errorMessage: null,
    },
  );
}

export function applyMetricPointsToSession(
  state: DashboardViewModel,
  sessionId: string,
  points: readonly DashboardClientMetricPoint[],
): DashboardViewModel {
  const existingSession = state.sessionsById[sessionId];
  if (!existingSession || points.length === 0) return state;
  return replaceSession(state, {
    ...existingSession,
    updatedAt: new Date(
      Math.max(Date.parse(existingSession.updatedAt), ...points.map((point) => point.timestampMs)),
    ).toISOString(),
    metrics: mergeMetrics(existingSession.metrics, mapMetricPoints(points)),
  });
}

function mergeMetrics(
  currentMetrics: DashboardMetric[],
  nextMetrics: DashboardMetric[],
): DashboardMetric[] {
  const mergedMetrics = new Map(currentMetrics.map((metric) => [metric.label, metric]));
  for (const metric of nextMetrics) {
    const existing = mergedMetrics.get(metric.label);
    // Keep the newer sample by timestamp so a late-arriving historical fetch cannot
    // overwrite a fresher live SSE sample for the same label.
    if (existing === undefined || metric.timestampMs >= existing.timestampMs) {
      mergedMetrics.set(metric.label, metric);
    }
  }
  return [...mergedMetrics.values()];
}

export function replaceSession(
  state: DashboardViewModel,
  session: DashboardSession,
): DashboardViewModel {
  const sessionsById = {
    ...state.sessionsById,
    [session.id]: session,
  };
  const sessions = sortSessionsByUpdatedAt(Object.values(sessionsById));

  return createViewModelState(
    {
      generatedAt: state.generatedAt,
      agents: state.agents,
      sessions,
    },
    {
      isLoading: state.isLoading,
      errorMessage: state.errorMessage,
      selectedAgentId: state.selectedAgentId,
      selectedSessionId: state.selectedSessionId,
      tracesByTurnId: state.tracesByTurnId,
      latestTurnByAgentId: state.latestTurnByAgentId,
      pendingMetricsBySessionId: state.pendingMetricsBySessionId,
    },
  );
}

export function replaceAgent(state: DashboardViewModel, agent: DashboardAgent): DashboardViewModel {
  const nextAgents = [...state.agents];
  const existingIndex = nextAgents.findIndex((candidate) => candidate.id === agent.id);

  if (existingIndex === -1) {
    nextAgents.push(agent);
  } else {
    nextAgents[existingIndex] = agent;
  }

  return createViewModelState(
    {
      generatedAt: state.generatedAt,
      agents: nextAgents,
      sessions: Object.values(state.sessionsById),
    },
    {
      isLoading: state.isLoading,
      errorMessage: state.errorMessage,
      selectedAgentId: state.selectedAgentId,
      selectedSessionId: state.selectedSessionId,
      tracesByTurnId: state.tracesByTurnId,
      latestTurnByAgentId: state.latestTurnByAgentId,
      pendingMetricsBySessionId: state.pendingMetricsBySessionId,
    },
  );
}
