/**
 * Agents page — responsive grid of agent status cards.
 */

import { AgentCard } from "../components/agents/agent-card.js";
import { ErrorBoundary } from "../components/shared/error-boundary.js";
import { EmptyState } from "../components/shared/empty-state.js";
import { AgentCardSkeleton } from "../components/shared/loading-skeleton.js";
import { useAgents } from "../hooks/use-agents.js";

function AgentsGrid(): React.ReactElement {
  const { agents, isLoading, error } = useAgents();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <AgentCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4">
        <p className="text-sm text-[var(--color-error)]">Failed to load agents</p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">{error.message}</p>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <EmptyState
        title="No agents running"
        description="Start an agent to see it appear here"
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {agents.map((agent) => (
        <AgentCard key={agent.agentId} agent={agent} />
      ))}
    </div>
  );
}

export function AgentsPage(): React.ReactElement {
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Agents</h2>
      </div>
      <ErrorBoundary>
        <AgentsGrid />
      </ErrorBoundary>
    </div>
  );
}
