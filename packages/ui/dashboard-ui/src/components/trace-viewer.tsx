import type { ReactElement } from "react";
import { formatTimestamp } from "../lib/format.js";
import type { DashboardTraceEntry } from "../lib/state.js";
import { EmptyState } from "./empty-state.js";
import { StatusPill } from "./status-pill.js";

export function TraceViewer({
  trace,
  ambiguous = false,
}: {
  trace: DashboardTraceEntry[];
  ambiguous?: boolean;
}): ReactElement {
  return (
    <section className="dashboard-panel" aria-label="Trace">
      <div className="panel-header">
        <div>
          <p className="panel-eyebrow">Execution · Latest turn for selected agent</p>
          <h2>Trace</h2>
        </div>
      </div>

      {ambiguous ? (
        <EmptyState
          title="Trace unavailable for multi-session agent"
          message="Server traces don't carry a sessionId, so the UI cannot prove which session a trace belongs to when this agent has more than one. Trace will appear once a session/turn mapping is wired through the API."
        />
      ) : trace.length === 0 ? (
        <EmptyState
          title="No trace events yet"
          message="Shows the most recent turn for the selected agent. Server traces don't carry a sessionId, so the trace pane is agent-scoped, not session-scoped."
        />
      ) : (
        <ol className="trace-list">
          {trace.map((entry) => (
            <li key={entry.id} className="trace-entry">
              <div className="trace-entry__header">
                <strong>{entry.label}</strong>
                <StatusPill status={entry.status} />
              </div>
              <p>{entry.detail}</p>
              <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
