import type { ReactElement } from "react";
import { useEffect, useReducer, useRef } from "react";
import { AgentList } from "./components/agent-list.js";
import { ErrorState } from "./components/error-state.js";
import { LoadingState } from "./components/loading-state.js";
import { MetricsPanel } from "./components/metrics-panel.js";
import { SessionDetail } from "./components/session-detail.js";
import { TraceViewer } from "./components/trace-viewer.js";
import {
  applyDashboardEvent,
  createEmptyDashboardViewModel,
  mapAgentSnapshot,
  mapMetricPoints,
  mapSessionSnapshot,
  mapTraceView,
  type DashboardEvent,
  type DashboardSnapshot,
  type DashboardViewModel,
} from "./lib/state.js";

export interface DashboardClient {
  listAgents(): Promise<
    | { readonly ok: true; readonly value: readonly Parameters<typeof mapAgentSnapshot>[0][] }
    | { readonly ok: false; readonly error: { readonly message?: string | undefined } }
  >;
  getAgent(id: string): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: { readonly message?: string | undefined } }>;
  listSessions(): Promise<
    | { readonly ok: true; readonly value: readonly Parameters<typeof mapSessionSnapshot>[0][] }
    | { readonly ok: false; readonly error: { readonly message?: string | undefined } }
  >;
  getMetrics(query: {
    readonly names: readonly string[];
    readonly fromMs: number;
    readonly toMs: number;
    readonly tags: Readonly<Record<string, string>>;
  }): Promise<
    | { readonly ok: true; readonly value: readonly Parameters<typeof mapMetricPoints>[0][number][] }
    | { readonly ok: false; readonly error: { readonly message?: string | undefined } }
  >;
  getTrace(turnId: string): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: { readonly message?: string | undefined } }>;
  listTraces?(query?: {
    readonly agentId?: string;
    readonly sinceMs?: number;
    readonly limit?: number;
  }): Promise<
    | {
        readonly ok: true;
        readonly value: { readonly items: readonly Parameters<typeof mapTraceView>[0][] };
      }
    | { readonly ok: false; readonly error: { readonly message?: string | undefined } }
  >;
  subscribe(
    topics: readonly ["agent-status", "session-summary", "metric", "trace"] | readonly string[],
    handlers: {
      readonly onEvent: (event:
        | { readonly kind: "agent-status"; readonly status: Parameters<typeof mapAgentSnapshot>[0] }
        | {
            readonly kind: "session-summary";
            readonly session: Parameters<typeof mapSessionSnapshot>[0];
          }
        | { readonly kind: "metric"; readonly points: readonly Parameters<typeof mapMetricPoints>[0][number][] }
        | { readonly kind: "trace"; readonly trace: Parameters<typeof mapTraceView>[0] }) => void;
      readonly onError?: (error: { readonly message?: string | undefined }) => void;
      readonly onClose?: () => void;
    },
  ): () => void;
}

function getErrorMessage(error: { readonly message?: string | undefined } | unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return fallback;
}

const SESSION_METRIC_NAMES = ["token_usage", "latency_ms", "tool_calls"] as const;

// The dashboard-api currently honors only `name` (single) and `since` server-side; it
// ignores `to` and tag filters. We issue one fetch per metric name, then filter the
// returned points to the target sessionId via point.tags?.sessionId so the panel is
// truly per-session even though the server can't enforce that filter.
function createMetricQuery(name: string, nowMs: number): {
  readonly names: readonly string[];
  readonly fromMs: number;
  readonly toMs: number;
  readonly tags: Readonly<Record<string, string>>;
} {
  return {
    names: [name],
    fromMs: Math.max(0, nowMs - 30 * 60_000),
    toMs: nowMs,
    tags: {},
  };
}

export async function loadDashboardSnapshot(
  client: DashboardClient,
  options?: { readonly nowMs?: number },
): Promise<DashboardSnapshot> {
  const nowMs = options?.nowMs ?? Date.now();
  const [agentsResult, sessionsResult] = await Promise.all([client.listAgents(), client.listSessions()]);

  if (!agentsResult.ok) {
    throw new Error(`Unable to load agents: ${getErrorMessage(agentsResult.error, "Unknown error")}`);
  }
  if (!sessionsResult.ok) {
    throw new Error(
      `Unable to load sessions: ${getErrorMessage(sessionsResult.error, "Unknown error")}`,
    );
  }

  const sessions = sessionsResult.value.map((session) => mapSessionSnapshot(session, nowMs));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    agents: agentsResult.value.map((agent) => mapAgentSnapshot(agent)),
    sessions,
  };
}

export async function fetchSessionMetrics(
  client: DashboardClient,
  sessionId: string,
  nowMs: number = Date.now(),
): Promise<readonly Parameters<typeof mapMetricPoints>[0][number][] | null> {
  const fromMs = Math.max(0, nowMs - 30 * 60_000);
  const responses = await Promise.all(
    SESSION_METRIC_NAMES.map((name) => client.getMetrics(createMetricQuery(name, nowMs))),
  );
  const collected: Parameters<typeof mapMetricPoints>[0][number][] = [];
  let anyOk = false;
  for (const response of responses) {
    if (!response.ok) continue;
    anyOk = true;
    for (const point of response.value) {
      // Hard-filter client-side because the dashboard-api parser ignores `to` and
      // `tag`; only `since` (the lower bound) is enforced server-side. Without
      // these guards the panel could merge old or cross-session samples as if
      // they were current per-session data.
      if (point.tags?.sessionId !== sessionId) continue;
      if (point.timestampMs < fromMs || point.timestampMs > nowMs) continue;
      collected.push(point);
    }
  }
  if (!anyOk) return null;
  return collected;
}

export function DashboardView({
  state,
  dispatch,
}: {
  state: DashboardViewModel;
  dispatch: (event: DashboardEvent) => void;
}): ReactElement {
  return (
    <main className="dashboard-shell">
      <section className="dashboard-hero" aria-label="Dashboard shell">
        <div>
          <p className="dashboard-eyebrow">Dashboard UI</p>
          <h1>Koi Dashboard</h1>
          <p className="dashboard-copy">
            Live fleet snapshot with incremental updates from the dashboard service.
          </p>
        </div>
      </section>

      {state.errorMessage ? <ErrorState message={state.errorMessage} /> : null}
      {state.isLoading ? <LoadingState /> : null}

      <div className="dashboard-layout">
        <AgentList
          agents={state.agents}
          generatedAt={state.generatedAt}
          selectedAgentId={state.selectedAgentId}
          onSelect={(agentId) => dispatch({ type: "agent.selected", agentId })}
        />

        <section className="dashboard-main">
          <SessionDetail
            selectedSession={state.selectedSession}
            visibleSessions={state.visibleSessions}
            onSelectSession={(sessionId) => dispatch({ type: "session.selected", sessionId })}
          />

          <div className="dashboard-grid">
            <MetricsPanel metrics={state.selectedSession?.metrics ?? []} />
            <TraceViewer
              trace={
                // Trace events have no sessionId, so we cannot prove a trace belongs
                // to the selected session when an agent has multiple sessions.
                // Suppress the trace contents in that case to avoid showing one
                // session's metrics next to another session's trace.
                state.selectedAgentId &&
                (state.sessionsByAgentId[state.selectedAgentId]?.length ?? 0) <= 1
                  ? state.selectedAgentTrace
                  : []
              }
              ambiguous={
                state.selectedAgentId !== null &&
                (state.sessionsByAgentId[state.selectedAgentId]?.length ?? 0) > 1
              }
            />
          </div>
        </section>
      </div>
    </main>
  );
}

type LiveEvent = Parameters<Parameters<DashboardClient["subscribe"]>[1]["onEvent"]>[0];

function dispatchLiveEvent(
  dispatch: (event: DashboardEvent) => void,
  event: LiveEvent,
): void {
  switch (event.kind) {
    case "agent-status":
      dispatch({ type: "agent.status.received", status: event.status });
      return;
    case "session-summary":
      dispatch({ type: "session.summary.received", session: event.session });
      return;
    case "metric":
      dispatch({ type: "metric.received", points: event.points });
      return;
    case "trace":
      dispatch({ type: "trace.received", trace: event.trace });
      return;
  }
}

export function DashboardApp({
  client,
}: {
  client: DashboardClient;
}): ReactElement {
  const [state, dispatch] = useReducer(applyDashboardEvent, undefined, createEmptyDashboardViewModel);
  const clientRef = useRef<DashboardClient>(client);
  clientRef.current = client;
  const selectedSessionId = state.selectedSessionId;

  useEffect(() => {
    let disposed = false;
    let snapshotApplied = false;
    const buffer: LiveEvent[] = [];
    dispatch({ type: "loading.set", isLoading: true });
    dispatch({ type: "error.set", message: null });

    // Subscribe FIRST so events emitted during the snapshot fetch window are buffered
    // and replayed after the snapshot is applied. This eliminates the bootstrap race
    // where live transitions arriving before subscribe() would be lost permanently.
    let unsubscribe = clientRef.current.subscribe(
      ["agent-status", "session-summary", "metric", "trace"],
      {
        onEvent: (event) => {
          if (disposed) return;
          if (!snapshotApplied) {
            buffer.push(event);
            return;
          }
          dispatchLiveEvent(dispatch, event);
        },
        onClose: () => {
          if (disposed) return;
          dispatch({ type: "error.set", message: "Live dashboard stream disconnected." });
        },
        onError: (error) => {
          if (disposed) return;
          dispatch({
            type: "error.set",
            message: getErrorMessage(error, "Live dashboard stream disconnected."),
          });
        },
      },
    );

    void (async () => {
      try {
        const snapshot = await loadDashboardSnapshot(clientRef.current);
        if (disposed) return;
        dispatch({ type: "snapshot.loaded", snapshot });
        snapshotApplied = true;
        // Replay any events that arrived during snapshot loading. Live events take
        // precedence over snapshot data because they are strictly newer.
        for (const buffered of buffer) {
          if (disposed) return;
          dispatchLiveEvent(dispatch, buffered);
        }
        buffer.length = 0;

        // Hydrate the trace cache from server history so the trace pane is populated
        // immediately after page load instead of waiting for the next live trace
        // event. Best-effort: skip silently if the SDK lacks listTraces or the call
        // fails (older servers may not implement /api/traces listing).
        const listTraces = clientRef.current.listTraces;
        if (listTraces) {
          await Promise.all(
            snapshot.agents.map(async (agent) => {
              const result = await listTraces.call(clientRef.current, {
                agentId: agent.id,
                limit: 1,
              });
              if (disposed || !result.ok) return;
              for (const trace of result.value.items) {
                dispatch({ type: "trace.received", trace });
              }
            }),
          );
        }
      } catch (error: unknown) {
        if (disposed) return;
        dispatch({
          type: "error.set",
          message: error instanceof Error ? error.message : "Unable to load dashboard data.",
        });
        // Snapshot failed: drop the buffered events and tear down the SSE
        // subscription so a degraded backend cannot turn the page into an
        // unbounded event sink. The UI surfaces the error and waits for a reload.
        buffer.length = 0;
        unsubscribe();
        unsubscribe = () => {};
      } finally {
        if (!disposed) {
          dispatch({ type: "loading.set", isLoading: false });
        }
      }
    })();

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  // Hydrate metrics for the currently selected session whenever it changes, so
  // sessions other than the first also get historical detail data.
  useEffect(() => {
    if (!selectedSessionId) return undefined;
    let cancelled = false;
    void (async () => {
      const points = await fetchSessionMetrics(clientRef.current, selectedSessionId);
      if (cancelled || points === null || points.length === 0) return;
      dispatch({ type: "metric.received", points });
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

  return <DashboardView state={state} dispatch={dispatch} />;
}
