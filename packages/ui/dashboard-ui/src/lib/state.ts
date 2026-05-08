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
  | { type: "snapshot.loaded"; snapshot: DashboardSnapshot }
  | { type: "agent.status.received"; status: DashboardClientAgentStatus }
  | { type: "session.summary.received"; session: DashboardClientSessionSummary; nowMs?: number }
  | { type: "metric.received"; points: readonly DashboardClientMetricPoint[] }
  | { type: "trace.received"; trace: DashboardClientTraceView }
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

function createViewModelState(
  snapshot: DashboardSnapshot,
  options?: {
    readonly isLoading?: boolean;
    readonly errorMessage?: string | null;
    readonly selectedAgentId?: string | null;
    readonly selectedSessionId?: string | null;
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

function titleCase(value: string): string {
  return value
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2);
}

function formatMetricValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString("en-US");
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(value < 10 ? 2 : 1);
}

function mapAgentState(state: string): AgentStatus {
  if (state.includes("error") || state.includes("fail")) return "error";
  if (state === "terminated") return "offline";
  if (state === "idle" || state === "waiting" || state === "suspended") return "idle";
  return "running";
}

function mapSessionStatus(status: string): SessionStatus {
  if (status === "active") return "active";
  if (status === "completed") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  return "queued";
}

export function mapAgentSnapshot(status: DashboardClientAgentStatus): DashboardAgent {
  const roleParts = [titleCase(status.agentType)];
  if (status.model) roleParts.push(status.model);

  return {
    id: status.agentId,
    name: status.name,
    role: roleParts.join(" · "),
    status: mapAgentState(status.state),
    region: status.channels[0] ?? "local",
    lastSeenAt: new Date(status.lastActivityAt).toISOString(),
  };
}

function createSummaryMetrics(summary: DashboardClientSessionSummary): DashboardMetric[] {
  const metrics: DashboardMetric[] = [
    {
      label: "Turns",
      value: formatCount(summary.turns),
      detail: "Completed turns in this session",
      trend: "steady",
    },
    {
      label: "Input Tokens",
      value: formatCount(summary.inputTokens),
      detail: "Prompt tokens recorded so far",
      trend: "steady",
    },
    {
      label: "Output Tokens",
      value: formatCount(summary.outputTokens),
      detail: "Completion tokens recorded so far",
      trend: "steady",
    },
  ];

  if (summary.costUsd >= 0) {
    metrics.push({
      label: "Cost",
      value: `$${summary.costUsd.toFixed(2)}`,
      detail: "Estimated spend to date",
      trend: "steady",
    });
  }

  return metrics;
}

export function mapSessionSnapshot(
  summary: DashboardClientSessionSummary,
  nowMs: number = Date.now(),
): DashboardSession {
  const updatedAtMs = summary.endedAt ?? nowMs;

  return {
    id: summary.sessionId,
    agentId: summary.agentId,
    title: `Session ${summary.sessionId}`,
    summary: `${titleCase(summary.status)} • ${formatCount(summary.turns)} turns • ${formatCount(summary.inputTokens)} in / ${formatCount(summary.outputTokens)} out`,
    status: mapSessionStatus(summary.status),
    startedAt: new Date(summary.startedAt).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    durationMs: Math.max(0, updatedAtMs - summary.startedAt),
    trace: [],
    metrics: createSummaryMetrics(summary),
  };
}

export function mapMetricPoints(points: readonly DashboardClientMetricPoint[]): DashboardMetric[] {
  const groupedPoints = new Map<string, DashboardClientMetricPoint[]>();

  for (const point of points) {
    const existingPoints = groupedPoints.get(point.name) ?? [];
    existingPoints.push(point);
    groupedPoints.set(point.name, existingPoints);
  }

  return [...groupedPoints.entries()].map(([name, metricPoints]) => {
    const sortedPoints = [...metricPoints].sort(
      (left, right) => left.timestampMs - right.timestampMs,
    );
    const latestPoint = sortedPoints[sortedPoints.length - 1];
    const previousPoint = sortedPoints[Math.max(0, sortedPoints.length - 2)];
    const trend =
      previousPoint === undefined ||
      latestPoint === undefined ||
      latestPoint.value === previousPoint.value
        ? "steady"
        : latestPoint.value > previousPoint.value
          ? "up"
          : "down";

    return {
      label: titleCase(name),
      value: latestPoint ? formatMetricValue(latestPoint.value) : "0",
      detail:
        metricPoints.length === 1
          ? "Latest live sample"
          : `${metricPoints.length.toLocaleString("en-US")} live samples`,
      trend,
    };
  });
}

function flattenTraceSpan(
  span: DashboardClientTraceSpan,
  entries: DashboardTraceEntry[],
  rootStartedAtMs: number,
): void {
  const status: TraceStatus = span.error
    ? "error"
    : span.children.length === 0
      ? "success"
      : "running";
  const detailParts = [`${titleCase(span.category)} span`, `${Math.round(span.durationMs)}ms`];
  if (span.error) detailParts.push(span.error);
  entries.push({
    id: span.spanId,
    label: span.name,
    detail: detailParts.join(" • "),
    timestamp: new Date(
      rootStartedAtMs + Math.max(0, span.startedAtMs - rootStartedAtMs),
    ).toISOString(),
    status,
  });

  for (const child of span.children) flattenTraceSpan(child, entries, rootStartedAtMs);
}

export function mapTraceView(trace: DashboardClientTraceView): DashboardTraceEntry[] {
  const entries: DashboardTraceEntry[] = [];
  for (const child of trace.root.children) flattenTraceSpan(child, entries, trace.startedAtMs);
  return entries;
}

function mergeMetrics(
  currentMetrics: DashboardMetric[],
  nextMetrics: DashboardMetric[],
): DashboardMetric[] {
  const mergedMetrics = new Map(currentMetrics.map((metric) => [metric.label, metric]));
  for (const metric of nextMetrics) mergedMetrics.set(metric.label, metric);
  return [...mergedMetrics.values()];
}

function replaceSession(state: DashboardViewModel, session: DashboardSession): DashboardViewModel {
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
    },
  );
}

function replaceAgent(state: DashboardViewModel, agent: DashboardAgent): DashboardViewModel {
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
    },
  );
}

function findTargetSessionId(state: DashboardViewModel, agentId: string): string | null {
  if (state.selectedSession?.agentId === agentId) {
    return state.selectedSession.id;
  }

  return state.sessionsByAgentId[agentId]?.[0]?.id ?? null;
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

    case "snapshot.loaded":
      return createViewModelState(event.snapshot, {
        isLoading: false,
        errorMessage: null,
        selectedAgentId: state.selectedAgentId,
        selectedSessionId: state.selectedSessionId,
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
      const nextSession = mapSessionSnapshot(event.session, event.nowMs);
      const mergedSession = previousSession
        ? {
            ...nextSession,
            metrics: previousSession.metrics,
            trace: previousSession.trace,
          }
        : nextSession;

      return replaceSession(
        createDerivedState({
          ...state,
          generatedAt: new Date(event.session.endedAt ?? event.nowMs ?? Date.now()).toISOString(),
        }),
        mergedSession,
      );
    }

    case "metric.received": {
      const pointsBySessionId = new Map<string, DashboardClientMetricPoint[]>();

      for (const point of event.points) {
        const sessionId =
          point.tags?.sessionId ??
          (point.tags?.agentId ? findTargetSessionId(state, point.tags.agentId) : null);
        if (sessionId === null) continue;
        const existingPoints = pointsBySessionId.get(sessionId) ?? [];
        existingPoints.push(point);
        pointsBySessionId.set(sessionId, existingPoints);
      }

      let nextState = state;
      for (const [sessionId, points] of pointsBySessionId) {
        const existingSession = nextState.sessionsById[sessionId];
        if (!existingSession) continue;
        nextState = replaceSession(nextState, {
          ...existingSession,
          updatedAt: new Date(
            Math.max(
              Date.parse(existingSession.updatedAt),
              ...points.map((point) => point.timestampMs),
            ),
          ).toISOString(),
          metrics: mergeMetrics(existingSession.metrics, mapMetricPoints(points)),
        });
      }
      return nextState;
    }

    case "trace.received": {
      const sessionId = findTargetSessionId(state, event.trace.agentId);
      if (sessionId === null) return state;
      const existingSession = state.sessionsById[sessionId];
      if (!existingSession) return state;

      return replaceSession(state, {
        ...existingSession,
        updatedAt: new Date(event.trace.startedAtMs + event.trace.totalDurationMs).toISOString(),
        trace: mapTraceView(event.trace),
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
