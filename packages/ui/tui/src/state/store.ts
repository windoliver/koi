/**
 * Immutable state store for the TUI application.
 *
 * Single state object, pure reducer, explicit render trigger.
 * No magic, no subscriptions, no external dependencies.
 */

import type { DashboardAgentSummary } from "@koi/dashboard-types";
import { isAgentEvent } from "@koi/dashboard-types";
import { MAX_SESSION_MESSAGES, type TuiAction, type TuiState } from "./types.js";

/** Listener callback for state changes. */
export type StateListener = (state: TuiState) => void;

/** Store interface — getState + dispatch + subscribe. */
export interface TuiStore {
  readonly getState: () => TuiState;
  readonly dispatch: (action: TuiAction) => void;
  readonly subscribe: (listener: StateListener) => () => void;
}

/**
 * Pure reducer — returns new state for each action.
 * Never mutates the input state.
 */
export function reduce(state: TuiState, action: TuiAction): TuiState {
  switch (action.kind) {
    case "set_view":
      return { ...state, view: action.view };

    case "set_agents":
      return {
        ...state,
        agents: action.agents,
        // Clamp selected index to new list bounds
        selectedAgentIndex: Math.min(
          state.selectedAgentIndex,
          Math.max(0, action.agents.length - 1),
        ),
      };

    case "select_agent":
      return {
        ...state,
        selectedAgentIndex: Math.max(0, Math.min(action.index, state.agents.length - 1)),
      };

    case "set_session":
      return { ...state, activeSession: action.session };

    case "append_tokens": {
      if (state.activeSession === null) return state;
      return {
        ...state,
        activeSession: {
          ...state.activeSession,
          pendingText: state.activeSession.pendingText + action.text,
        },
      };
    }

    case "flush_tokens": {
      if (state.activeSession === null) return state;
      if (state.activeSession.pendingText === "") return state;
      const flushedMessage = {
        kind: "assistant" as const,
        text: state.activeSession.pendingText,
        timestamp: Date.now(),
      };
      const messages = [...state.activeSession.messages, flushedMessage].slice(
        -MAX_SESSION_MESSAGES,
      );
      return {
        ...state,
        activeSession: {
          ...state.activeSession,
          pendingText: "",
          messages,
        },
      };
    }

    case "add_message": {
      if (state.activeSession === null) return state;
      const messages = [...state.activeSession.messages, action.message].slice(
        -MAX_SESSION_MESSAGES,
      );
      return {
        ...state,
        activeSession: {
          ...state.activeSession,
          messages,
        },
      };
    }

    case "set_connection_status":
      return { ...state, connectionStatus: action.status };

    case "set_streaming": {
      if (state.activeSession === null) return state;
      return {
        ...state,
        activeSession: {
          ...state.activeSession,
          isStreaming: action.isStreaming,
        },
      };
    }

    case "set_error":
      return { ...state, error: action.error };

    case "apply_event_batch": {
      const { batch } = action;
      let updatedAgents: readonly DashboardAgentSummary[] | null = null;

      for (const event of batch.events) {
        if (isAgentEvent(event)) {
          // Mark agents list as needing refresh
          // For now, we just flag it — the view layer will re-fetch
          updatedAgents = state.agents;
        }
      }

      return {
        ...state,
        lastEventSeq: batch.seq,
        // If we got agent events, keep existing agents (view will re-fetch)
        ...(updatedAgents !== null ? { agents: updatedAgents } : {}),
      };
    }
  }
}

/** Create an immutable store with dispatch + subscribe. */
export function createStore(initialState: TuiState): TuiStore {
  let current = initialState;
  const listeners = new Set<StateListener>();

  return {
    getState(): TuiState {
      return current;
    },

    dispatch(action: TuiAction): void {
      const next = reduce(current, action);
      if (next !== current) {
        current = next;
        for (const listener of listeners) {
          listener(current);
        }
      }
    },

    subscribe(listener: StateListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
