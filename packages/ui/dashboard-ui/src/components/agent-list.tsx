import type { ReactElement } from "react";
import { formatRelativeMinutes } from "../lib/format.js";
import type { DashboardAgent } from "../lib/state.js";
import { StatusPill } from "./status-pill.js";

export function AgentList({
  agents,
  generatedAt,
  selectedAgentId,
  onSelect,
}: {
  agents: DashboardAgent[];
  generatedAt: string;
  selectedAgentId: string | null;
  onSelect: (agentId: string) => void;
}): ReactElement {
  return (
    <section className="dashboard-panel dashboard-panel--sidebar" aria-label="Agents">
      <div className="panel-header">
        <div>
          <p className="panel-eyebrow">Fleet</p>
          <h2>Agents</h2>
        </div>
      </div>

      <div className="agent-list">
        {agents.map((agent) => {
          const isSelected = agent.id === selectedAgentId;

          return (
            <button
              key={agent.id}
              type="button"
              className={`agent-card${isSelected ? " agent-card--selected" : ""}`}
              onClick={() => onSelect(agent.id)}
              aria-pressed={isSelected}
            >
              <div className="agent-card__topline">
                <div>
                  <strong>{agent.name}</strong>
                  <p>{agent.role}</p>
                </div>
                <StatusPill status={agent.status} />
              </div>
              <dl className="agent-card__meta">
                <div>
                  <dt>Region</dt>
                  <dd>{agent.region}</dd>
                </div>
                <div>
                  <dt>Seen</dt>
                  <dd>{formatRelativeMinutes(agent.lastSeenAt, generatedAt)}</dd>
                </div>
              </dl>
            </button>
          );
        })}
      </div>
    </section>
  );
}
