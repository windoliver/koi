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

function createMetricQuery(sessionId: string, nowMs: number): {
  readonly names: readonly string[];
  readonly fromMs: number;
  readonly toMs: number;
  readonly tags: Readonly<Record<string, string>>;
} {
  return {
    names: ["token_usage", "latency_ms", "tool_calls"],
    fromMs: Math.max(0, nowMs - 30 * 60_000),
    toMs: nowMs,
    tags: { sessionId },
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
  const firstSessionId = sessions[0]?.id;

  if (firstSessionId) {
    const metricsResult = await client.getMetrics(createMetricQuery(firstSessionId, nowMs));
    if (metricsResult.ok) {
      const firstSession = sessions.find((session) => session.id === firstSessionId);
      if (firstSession) {
        firstSession.metrics = mapMetricPoints(metricsResult.value);
      }
    }
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    agents: agentsResult.value.map((agent) => mapAgentSnapshot(agent)),
    sessions,
  };
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
            <TraceViewer trace={state.selectedSession?.trace ?? []} />
          </div>
        </section>
      </div>
    </main>
  );
}

export function DashboardApp({
  client,
}: {
  client: DashboardClient;
}): ReactElement {
  const [state, dispatch] = useReducer(applyDashboardEvent, undefined, createEmptyDashboardViewModel);
  const clientRef = useRef<DashboardClient>(client);
  clientRef.current = client;

  useEffect(() => {
    let disposed = false;
    let unsubscribe: () => void = () => {};
    dispatch({ type: "loading.set", isLoading: true });
    dispatch({ type: "error.set", message: null });

    void (async () => {
      try {
        const snapshot = await loadDashboardSnapshot(clientRef.current);
        if (disposed) return;
        dispatch({ type: "snapshot.loaded", snapshot });

        unsubscribe = clientRef.current.subscribe(
          ["agent-status", "session-summary", "metric", "trace"],
          {
            onEvent: (event) => {
              if (disposed) return;
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
      } catch (error: unknown) {
        if (disposed) return;
        dispatch({
          type: "error.set",
          message: error instanceof Error ? error.message : "Unable to load dashboard data.",
        });
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

  return <DashboardView state={state} dispatch={dispatch} />;
}
