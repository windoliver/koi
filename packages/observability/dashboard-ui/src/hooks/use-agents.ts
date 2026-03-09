/**
 * Agent data hook — Zustand as sole source of truth (Decision 5A).
 *
 * Fetches agents on mount + at 30s intervals, writes directly to Zustand.
 * SSE events update the store independently — no React Query sync hazards.
 */

import type { DashboardAgentSummary } from "@koi/dashboard-types";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { fetchAgents } from "../lib/api-client.js";
import { useAgentsStore } from "../stores/agents-store.js";

const REFETCH_INTERVAL_MS = 30_000;

export function useAgents(): {
  readonly agents: readonly DashboardAgentSummary[];
  readonly isLoading: boolean;
  readonly error: Error | null;
} {
  const setAgents = useAgentsStore((s) => s.setAgents);
  const setLoading = useAgentsStore((s) => s.setLoading);
  const setError = useAgentsStore((s) => s.setError);

  // Stable selector — useShallow prevents re-renders when array contents haven't changed
  const agentsList = useAgentsStore(useShallow((s) => Object.values(s.agents)));
  const isLoading = useAgentsStore((s) => s.isLoading);
  const error = useAgentsStore((s) => s.error);

  useEffect(() => {
    let mounted = true;

    const load = async (): Promise<void> => {
      // Only show loading skeleton on initial fetch (empty store).
      // Subsequent polls should not blank the page.
      const isInitial = Object.keys(useAgentsStore.getState().agents).length === 0;
      if (isInitial) {
        setLoading(true);
      }

      const fetchStartedAt = Date.now();
      try {
        const agents = await fetchAgents();
        if (mounted) {
          setAgents(agents, fetchStartedAt);
        }
      } catch (e: unknown) {
        if (mounted) {
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      } finally {
        if (mounted && isInitial) {
          setLoading(false);
        }
      }
    };

    void load();
    const timer = setInterval(() => void load(), REFETCH_INTERVAL_MS);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [setAgents, setLoading, setError]);

  return { agents: agentsList, isLoading, error };
}
