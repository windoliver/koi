/**
 * Initial state factory — single source of truth for the TUI's starting state.
 */

import type { TuiState } from "./types.js";

/** Create a fresh TUI state with sensible defaults. */
export function createInitialState(): TuiState {
  return {
    messages: [],
    activeView: "conversation",
    modal: null,
    connectionStatus: "disconnected",
    layoutTier: "normal",
    zoomLevel: 1,
  };
}
