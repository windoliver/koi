import type { ReactElement } from "react";
import { formatTimestamp } from "../lib/format.js";
import type { DashboardTraceEntry } from "../lib/state.js";
import { EmptyState } from "./empty-state.js";
import { StatusPill } from "./status-pill.js";

export function TraceViewer({ trace }: { trace: DashboardTraceEntry[] }): ReactElement {
  return (
    <section className="dashboard-panel" aria-label="Trace">
      <div className="panel-header">
        <div>
          <p className="panel-eyebrow">Execution</p>
          <h2>Trace</h2>
        </div>
      </div>

      {trace.length === 0 ? (
        <EmptyState
          title="No trace events yet"
          message="Trace entries will appear here once the selected session starts doing work."
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
