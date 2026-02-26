/**
 * Zustand store for agent state — SSE events update individual agents
 * without re-rendering the entire grid.
 */

import type { DashboardAgentSummary } from "@koi/dashboard-types";
import { create } from "zustand";

interface AgentsState {
  readonly agents: Readonly<Record<string, DashboardAgentSummary>>;
  readonly lastUpdated: number;
  readonly setAgents: (agents: readonly DashboardAgentSummary[]) => void;
  readonly updateAgent: (agentId: string, partial: Partial<DashboardAgentSummary>) => void;
  readonly removeAgent: (agentId: string) => void;
}

export const useAgentsStore = create<AgentsState>((set) => ({
  agents: {},
  lastUpdated: 0,

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
}));

/** Select a single agent by ID — prevents unnecessary re-renders. */
export function useAgentById(agentId: string): DashboardAgentSummary | undefined {
  return useAgentsStore((state) => state.agents[agentId]);
}

/** Select all agents as an array. */
export function useAgentsList(): readonly DashboardAgentSummary[] {
  return useAgentsStore((state) => Object.values(state.agents));
}
