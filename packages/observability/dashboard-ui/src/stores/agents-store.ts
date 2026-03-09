/**
 * Zustand store for agent state — SSE events update individual agents
 * without re-rendering the entire grid.
 *
 * This is the SOLE source of truth for agent data (Decision 5A).
 * React Query is NOT used for agents — fetch writes directly here.
 */

import type { DashboardAgentSummary } from "@koi/dashboard-types";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

interface AgentsState {
  readonly agents: Readonly<Record<string, DashboardAgentSummary>>;
  readonly lastUpdated: number;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly setAgents: (agents: readonly DashboardAgentSummary[]) => void;
  readonly updateAgent: (agentId: string, partial: Partial<DashboardAgentSummary>) => void;
  readonly removeAgent: (agentId: string) => void;
  readonly setLoading: (isLoading: boolean) => void;
  readonly setError: (error: Error | null) => void;
}

export const useAgentsStore = create<AgentsState>((set) => ({
  agents: {},
  lastUpdated: 0,
  isLoading: true,
  error: null,

  setAgents: (agents) =>
    set(() => {
      const record: Record<string, DashboardAgentSummary> = {};
      for (const agent of agents) {
        record[agent.agentId] = agent;
      }
      return { agents: record, lastUpdated: Date.now() };
    }),

  updateAgent: (agentId, partial) =>
    set((state) => {
      const existing = state.agents[agentId];
      if (existing === undefined) return state;
      return {
        agents: {
          ...state.agents,
          [agentId]: { ...existing, ...partial },
        },
        lastUpdated: Date.now(),
      };
    }),

  removeAgent: (agentId) =>
    set((state) => {
      const { [agentId]: _, ...rest } = state.agents;
      return { agents: rest, lastUpdated: Date.now() };
    }),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),
}));

/** Select a single agent by ID — prevents unnecessary re-renders. */
export function useAgentById(agentId: string): DashboardAgentSummary | undefined {
  return useAgentsStore((state) => state.agents[agentId]);
}

/**
 * Select all agents as a stable array — uses useShallow to prevent
 * re-renders when array contents haven't changed (Decision 8A).
 */
export function useAgentsList(): readonly DashboardAgentSummary[] {
  return useAgentsStore(useShallow((state) => Object.values(state.agents)));
}
