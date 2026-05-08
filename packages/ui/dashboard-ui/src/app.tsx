import type { ReactElement } from "react";
import { useReducer } from "react";
import { AgentList } from "./components/agent-list.js";
import { ErrorState } from "./components/error-state.js";
import { LoadingState } from "./components/loading-state.js";
import { MetricsPanel } from "./components/metrics-panel.js";
import { SessionDetail } from "./components/session-detail.js";
import { TraceViewer } from "./components/trace-viewer.js";
import { demoDashboardData } from "./lib/demo-data.js";
import { applyDashboardEvent, createDashboardViewModel } from "./lib/state.js";

export function DashboardApp(): ReactElement {
  const [state, dispatch] = useReducer(
    applyDashboardEvent,
    demoDashboardData,
    createDashboardViewModel,
  );

  return (
    <main className="dashboard-shell">
      <section className="dashboard-hero" aria-label="Dashboard shell">
        <div>
          <p className="dashboard-eyebrow">Dashboard UI</p>
          <h1>Koi Dashboard</h1>
          <p className="dashboard-copy">
            A local MVP shell for browsing demo fleet state before the live dashboard client lands.
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
