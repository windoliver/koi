import type {
  AgentStatus,
  DashboardAgent,
  DashboardClientAgentStatus,
  DashboardClientMetricPoint,
  DashboardClientSessionSummary,
  DashboardClientTraceSpan,
  DashboardClientTraceView,
  DashboardMetric,
  DashboardSession,
  DashboardTraceEntry,
  SessionStatus,
  TraceStatus,
} from "./state.js";

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
