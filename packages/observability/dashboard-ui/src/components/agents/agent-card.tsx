/**
 * Agent status card — shows name, state, model, channels, uptime.
 */

import type { DashboardAgentSummary } from "@koi/dashboard-types";
import { formatDuration, formatRelativeTime } from "../../lib/format.js";
import { AgentStatusBadge } from "./agent-status-badge.js";

export function AgentCard({
  agent,
}: {
  readonly agent: DashboardAgentSummary;
}): React.ReactElement {
  const uptime = Date.now() - agent.startedAt;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 transition-colors hover:border-[var(--color-muted)]/30">
      <div className="flex items-center justify-between">
        <h3 className="truncate text-sm font-medium">{agent.name}</h3>
        <AgentStatusBadge state={agent.state} />
      </div>

      <div className="mt-3 space-y-1.5 text-xs text-[var(--color-muted)]">
        <div className="flex justify-between">
          <span>Type</span>
          <span className="text-[var(--color-foreground)]">{agent.agentType}</span>
        </div>

        {agent.model !== undefined && (
          <div className="flex justify-between">
            <span>Model</span>
            <span className="truncate pl-4 text-[var(--color-foreground)]">{agent.model}</span>
          </div>
        )}

        <div className="flex justify-between">
          <span>Channels</span>
          <span className="text-[var(--color-foreground)]">
            {agent.channels.length > 0 ? agent.channels.join(", ") : "none"}
          </span>
        </div>

        <div className="flex justify-between">
          <span>Turns</span>
          <span className="text-[var(--color-foreground)]">{agent.turns}</span>
        </div>

        <div className="flex justify-between">
          <span>Uptime</span>
          <span className="text-[var(--color-foreground)]">{formatDuration(uptime)}</span>
        </div>

        <div className="flex justify-between">
          <span>Last activity</span>
          <span className="text-[var(--color-foreground)]">
            {formatRelativeTime(agent.lastActivityAt)}
          </span>
        </div>
      </div>
    </div>
  );
}
