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

type DerivedFreeBase = Omit<
  DashboardViewModel,
  "visibleSessions" | "selectedSession" | "selectedAgentTrace"
>;

function createDerivedState(baseState: DerivedFreeBase): DashboardViewModel {
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

function createViewModelState(
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

function createSummaryMetrics(
  summary: DashboardClientSessionSummary,
  nowMs: number,
): DashboardMetric[] {
  const summaryTimestampMs = summary.endedAt ?? nowMs;
  const metrics: DashboardMetric[] = [
    {
      label: "Turns",
      value: formatCount(summary.turns),
      detail: "Completed turns in this session",
      trend: "steady",
      timestampMs: summaryTimestampMs,
    },
    {
      label: "Input Tokens",
      value: formatCount(summary.inputTokens),
      detail: "Prompt tokens recorded so far",
      trend: "steady",
      timestampMs: summaryTimestampMs,
    },
    {
      label: "Output Tokens",
      value: formatCount(summary.outputTokens),
      detail: "Completion tokens recorded so far",
      trend: "steady",
      timestampMs: summaryTimestampMs,
    },
  ];

  if (summary.costUsd >= 0) {
    metrics.push({
      label: "Cost",
      value: `$${summary.costUsd.toFixed(2)}`,
      detail: "Estimated spend to date",
      trend: "steady",
      timestampMs: summaryTimestampMs,
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
    metrics: createSummaryMetrics(summary, nowMs),
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
      timestampMs: latestPoint?.timestampMs ?? 0,
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

// Per-session ceiling on buffered orphan metric points. Bounds memory if a
// session-summary never arrives for a given sessionId (misbehaving backend).
const PENDING_METRICS_PER_SESSION_LIMIT = 1000;

function applyMetricPointsToSession(
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
      tracesByTurnId: state.tracesByTurnId,
      latestTurnByAgentId: state.latestTurnByAgentId,
      pendingMetricsBySessionId: state.pendingMetricsBySessionId,
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
      tracesByTurnId: state.tracesByTurnId,
      latestTurnByAgentId: state.latestTurnByAgentId,
      pendingMetricsBySessionId: state.pendingMetricsBySessionId,
    },
  );
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
