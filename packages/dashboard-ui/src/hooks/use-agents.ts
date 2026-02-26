/**
 * TanStack Query hook for agent data — initial REST fetch + SSE-driven invalidation.
 */

import type { DashboardAgentSummary } from "@koi/dashboard-types";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { fetchAgents } from "../lib/api-client.js";
import { useAgentsStore } from "../stores/agents-store.js";

export const AGENTS_QUERY_KEY = ["agents"] as const;

export function useAgents(): {
  readonly agents: readonly DashboardAgentSummary[];
  readonly isLoading: boolean;
  readonly error: Error | null;
} {
  const setAgents = useAgentsStore((s) => s.setAgents);
  const agentsList = useAgentsStore((s) => Object.values(s.agents));

  const query = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: fetchAgents,
    refetchInterval: 30_000,
  });

  // Sync REST data to Zustand store
  useEffect(() => {
    if (query.data !== undefined) {
      setAgents(query.data);
    }
  }, [query.data, setAgents]);

  return {
    agents: agentsList,
    isLoading: query.isLoading,
    error: query.error,
  };
}
