import type { ReactElement } from "react";
import { formatDuration, formatTimestamp } from "../lib/format.js";
import type { DashboardSession } from "../lib/state.js";
import { EmptyState } from "./empty-state.js";
import { StatusPill } from "./status-pill.js";

export function SessionDetail({
  selectedSession,
  visibleSessions,
  onSelectSession,
}: {
  selectedSession: DashboardSession | null;
  visibleSessions: DashboardSession[];
  onSelectSession: (sessionId: string) => void;
}): ReactElement {
  if (!selectedSession) {
    return (
      <section className="dashboard-panel">
        <EmptyState
          title="No session selected"
          message="Pick an agent to inspect its latest local demo session."
        />
      </section>
    );
  }

  return (
    <section className="dashboard-panel session-detail" aria-label="Session detail">
      <div className="panel-header">
        <div>
          <p className="panel-eyebrow">Session detail</p>
          <h2>{selectedSession.title}</h2>
        </div>
        <StatusPill status={selectedSession.status} />
      </div>

      <p className="session-detail__summary">{selectedSession.summary}</p>

      <dl className="session-detail__meta">
        <div>
          <dt>Started</dt>
          <dd>{formatTimestamp(selectedSession.startedAt)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatTimestamp(selectedSession.updatedAt)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(selectedSession.durationMs)}</dd>
        </div>
      </dl>

      <div className="session-switcher" aria-label="Agent sessions">
        {visibleSessions.map((session) => {
          const isCurrent = session.id === selectedSession.id;

          return (
            <button
              key={session.id}
              type="button"
              className={`session-chip${isCurrent ? " session-chip--selected" : ""}`}
              onClick={() => onSelectSession(session.id)}
              aria-pressed={isCurrent}
            >
              <span>{session.title}</span>
              <StatusPill status={session.status} />
            </button>
          );
        })}
      </div>
    </section>
  );
}
