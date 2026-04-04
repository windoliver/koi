/**
 * Initial state factory — single source of truth for the TUI's starting state.
 */

import type { CumulativeMetrics, TuiState } from "./types.js";

const INITIAL_METRICS: CumulativeMetrics = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  costUsd: null,
};

/** Create a fresh TUI state with sensible defaults. */
export function createInitialState(): TuiState {
  return {
    messages: [],
    activeView: "conversation",
    modal: null,
    connectionStatus: "disconnected",
    layoutTier: "normal",
    zoomLevel: 1,
    sessionInfo: null,
    cumulativeMetrics: INITIAL_METRICS,
    agentStatus: "idle",
    sessions: [],
  };
}
