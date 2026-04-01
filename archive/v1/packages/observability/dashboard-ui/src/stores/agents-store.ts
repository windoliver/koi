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
  /**
   * Timestamp of the last successful full refresh (setAgents).
   * Used solely to guard against two concurrent full-refresh responses
   * racing (e.g. poll vs reconnect). SSE mutations do NOT touch this
   * field, so a status_changed arriving mid-fetch won't cause the
   * refresh to be silently dropped.
   */
  readonly lastFullRefresh: number;
  readonly isLoading: boolean;
  /** Set to true after the first successful fetch, even if 0 agents returned. */
  readonly initialLoadDone: boolean;
  readonly error: Error | null;
  /**
   * Replace the full agent map. Pass `fetchStartedAt` (captured before the
   * async fetch) so that a slower concurrent full-refresh cannot overwrite
   * a faster one that already completed.
   */
  readonly setAgents: (agents: readonly DashboardAgentSummary[], fetchStartedAt: number) => void;
  readonly updateAgent: (agentId: string, partial: Partial<DashboardAgentSummary>) => void;
  readonly removeAgent: (agentId: string) => void;
  readonly setLoading: (isLoading: boolean) => void;
  readonly setError: (error: Error | null) => void;
}

export const useAgentsStore = create<AgentsState>((set) => ({
  agents: {},
  lastFullRefresh: 0,
  isLoading: true,
  initialLoadDone: false,
  error: null,

  setAgents: (agents, fetchStartedAt) =>
    set((state) => {
      // Guard: only reject if another *full refresh* completed after this one started.
      // SSE mutations (updateAgent/removeAgent) don't touch lastFullRefresh,
      // so they can't cause a full refresh to be silently dropped.
      if (fetchStartedAt < state.lastFullRefresh) return state;
      const record: Record<string, DashboardAgentSummary> = {};
      for (const agent of agents) {
        record[agent.agentId] = agent;
      }
      return {
        agents: record,
        lastFullRefresh: Date.now(),
        initialLoadDone: true,
        error: null,
      };
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
      };
    }),

  removeAgent: (agentId) =>
    set((state) => {
      const { [agentId]: _, ...rest } = state.agents;
      return { agents: rest };
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
