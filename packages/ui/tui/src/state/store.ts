/**
 * Immutable state store for the TUI application.
 *
 * Single state object, pure reducer, explicit render trigger.
 * No magic, no subscriptions, no external dependencies.
 */

import type { ChatMessage } from "@koi/dashboard-client";
import type { DashboardAgentSummary, ForgeDashboardEvent } from "@koi/dashboard-types";
import { isAgentEvent, isForgeEvent, isMonitorEvent } from "@koi/dashboard-types";
import type { TuiBrickSummary } from "./types.js";
import { MAX_SESSION_MESSAGES, type TuiAction, type TuiState, type ZoomLevel } from "./types.js";

const MAX_FORGE_EVENTS = 200;
const MAX_MONITOR_EVENTS = 50;
const MAX_FORGE_SPARKLINE_POINTS = 50;
const MAX_PTY_CHUNKS = 1000;

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
      const flushedMessage: ChatMessage = {
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

    case "update_tool_result": {
      if (state.activeSession === null) return state;
      const { toolCallId, result } = action;
      // Find the last tool_call message matching this toolCallId and update it
      const msgs = state.activeSession.messages;
      let targetIndex = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg !== undefined && msg.kind === "tool_call" && msg.toolCallId === toolCallId) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex === -1) return state;
      const target = msgs[targetIndex];
      if (target === undefined || target.kind !== "tool_call") return state;
      const updatedMessage: ChatMessage = {
        ...target,
        result,
      };
      const updatedMessages = [
        ...msgs.slice(0, targetIndex),
        updatedMessage,
        ...msgs.slice(targetIndex + 1),
      ];
      return {
        ...state,
        activeSession: {
          ...state.activeSession,
          messages: updatedMessages,
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

    case "set_session_picker":
      return {
        ...state,
        sessionPickerEntries: action.entries,
        sessionPickerLoading: action.loading,
      };

    case "set_data_sources":
      return {
        ...state,
        dataSources: action.sources,
        dataSourcesLoading: false,
        selectedDataSourceIndex: Math.min(
          state.selectedDataSourceIndex,
          Math.max(0, action.sources.length - 1),
        ),
      };

    case "set_data_sources_loading":
      return { ...state, dataSourcesLoading: action.loading };

    case "select_data_source":
      return {
        ...state,
        selectedDataSourceIndex: Math.max(0, Math.min(action.index, state.dataSources.length - 1)),
      };

    case "set_source_detail":
      return { ...state, sourceDetail: action.detail, sourceDetailLoading: false };

    case "set_source_detail_loading":
      return { ...state, sourceDetailLoading: action.loading };

    case "set_pending_consent":
      return { ...state, pendingConsent: action.sources };

    case "clear_pending_consent":
      return { ...state, pendingConsent: undefined };

    case "apply_event_batch": {
      const { batch } = action;
      let updatedAgents: readonly DashboardAgentSummary[] | null = null;
      const forgeEvents: ForgeDashboardEvent[] = [];

      // Gap detection: warn if sequence numbers are not contiguous
      const expectedSeq = state.lastEventSeq + 1;
      const hasGap = state.lastEventSeq > 0 && batch.seq !== expectedSeq;

      for (const event of batch.events) {
        if (isAgentEvent(event)) {
          updatedAgents = state.agents;
        }
        if (isForgeEvent(event)) {
          forgeEvents.push(event);
        }
      }

      // Apply forge events inline if any were found
      const forgeState = forgeEvents.length > 0 ? applyForgeBatch(state, forgeEvents) : {};

      // Apply monitor events
      let monitorState = {};
      for (const event of batch.events) {
        if (isMonitorEvent(event)) {
          const combined = [
            ...((monitorState as { readonly monitorEvents?: readonly (typeof event)[] })
              .monitorEvents ?? state.monitorEvents),
            event,
          ];
          monitorState = {
            monitorEvents:
              combined.length > MAX_MONITOR_EVENTS ? combined.slice(-MAX_MONITOR_EVENTS) : combined,
          };
        }
      }

      return {
        ...state,
        lastEventSeq: batch.seq,
        ...(updatedAgents !== null ? { agents: updatedAgents } : {}),
        ...forgeState,
        ...monitorState,
        // Surface gap as an error for UI to handle
        ...(hasGap
          ? {
              error: {
                kind: "api_error" as const,
                code: "SSE_GAP",
                message: `SSE gap detected: expected seq ${String(expectedSeq)}, got ${String(batch.seq)}`,
              },
            }
          : {}),
      };
    }

    case "apply_forge_batch":
      return { ...state, ...applyForgeBatch(state, action.events) };

    case "apply_monitor_event": {
      const combined = [...state.monitorEvents, action.event];
      return {
        ...state,
        monitorEvents:
          combined.length > MAX_MONITOR_EVENTS ? combined.slice(-MAX_MONITOR_EVENTS) : combined,
      };
    }

    case "set_zoom_level":
      return { ...state, zoomLevel: action.level };

    case "cycle_zoom": {
      const ZOOM_CYCLE: readonly ZoomLevel[] = ["normal", "half", "full"];
      const currentIdx = ZOOM_CYCLE.indexOf(state.zoomLevel);
      const nextIdx = (currentIdx + 1) % ZOOM_CYCLE.length;
      const nextZoom = ZOOM_CYCLE[nextIdx];
      return nextZoom !== undefined ? { ...state, zoomLevel: nextZoom } : state;
    }

    case "set_presets":
      return { ...state, presets: action.presets };

    case "select_preset":
      return {
        ...state,
        selectedPresetIndex: Math.max(0, Math.min(action.index, state.presets.length - 1)),
      };

    case "set_active_preset_detail":
      return { ...state, activePresetDetail: action.detail };

    case "set_selected_preset_id":
      return { ...state, selectedPresetId: action.presetId };

    case "set_agent_name_input":
      return { ...state, agentNameInput: action.name };

    case "toggle_addon": {
      const current = state.selectedAddons;
      const next = new Set(current);
      if (next.has(action.addonId)) {
        next.delete(action.addonId);
      } else {
        next.add(action.addonId);
      }
      return { ...state, selectedAddons: next };
    }

    case "set_addon_focused_index":
      return { ...state, addonFocusedIndex: Math.max(0, action.index) };

    case "append_pty_data": {
      const prev = state.ptyBuffers[action.agentId] ?? [];
      const updated = [...prev, action.data].slice(-MAX_PTY_CHUNKS);
      return {
        ...state,
        ptyBuffers: { ...state.ptyBuffers, [action.agentId]: updated },
      };
    }

    case "clear_pty_buffer": {
      const { [action.agentId]: _, ...rest } = state.ptyBuffers;
      return { ...state, ptyBuffers: rest };
    }

    case "set_split_session":
      return {
        ...state,
        splitSessions: {
          ...state.splitSessions,
          [action.agentId]: action.session,
        },
      };

    case "remove_split_session": {
      const { [action.agentId]: _, ...rest } = state.splitSessions;
      return { ...state, splitSessions: rest };
    }

    case "append_split_tokens": {
      const session = state.splitSessions[action.agentId];
      if (session === undefined) return state;
      return {
        ...state,
        splitSessions: {
          ...state.splitSessions,
          [action.agentId]: {
            ...session,
            pendingText: session.pendingText + action.text,
          },
        },
      };
    }

    case "flush_split_tokens": {
      const session = state.splitSessions[action.agentId];
      if (session === undefined) return state;
      if (session.pendingText === "") return state;
      const flushedMessage: ChatMessage = {
        kind: "assistant" as const,
        text: session.pendingText,
        timestamp: Date.now(),
      };
      const messages = [...session.messages, flushedMessage].slice(-MAX_SESSION_MESSAGES);
      return {
        ...state,
        splitSessions: {
          ...state.splitSessions,
          [action.agentId]: {
            ...session,
            pendingText: "",
            messages,
          },
        },
      };
    }

    case "set_focused_pane": {
      // Clamp to agents.length — split panes are built from the agent list,
      // not splitSessions (which are only populated for interactive chat sessions)
      const paneCount = Math.max(state.agents.length, Object.keys(state.splitSessions).length);
      const maxIndex = Math.max(0, paneCount - 1);
      return {
        ...state,
        focusedPaneIndex: Math.max(0, Math.min(action.index, maxIndex)),
      };
    }
  }
}

/** Apply a batch of forge events to the TUI state. */
function applyForgeBatch(
  state: TuiState,
  events: readonly ForgeDashboardEvent[],
): Partial<TuiState> {
  if (events.length === 0) return {};

  const bricks: Record<string, TuiBrickSummary> = { ...state.forgeBricks };
  const sparklines: Record<string, readonly number[]> = { ...state.forgeSparklines };

  for (const event of events) {
    switch (event.subKind) {
      case "brick_forged":
      case "brick_demand_forged":
        bricks[event.brickId] = { name: event.name, status: "active", fitness: 0 };
        break;
      case "brick_deprecated":
        if (bricks[event.brickId] !== undefined) {
          bricks[event.brickId] = {
            ...bricks[event.brickId]!,
            status: "deprecated",
            fitness: event.fitnessOriginal,
          };
        }
        break;
      case "brick_promoted":
        if (bricks[event.brickId] !== undefined) {
          bricks[event.brickId] = {
            ...bricks[event.brickId]!,
            status: "promoted",
            fitness: event.fitnessOriginal,
          };
        }
        break;
      case "brick_quarantined":
        if (bricks[event.brickId] !== undefined) {
          bricks[event.brickId] = { ...bricks[event.brickId]!, status: "quarantined" };
        }
        break;
      case "fitness_flushed": {
        if (bricks[event.brickId] !== undefined) {
          bricks[event.brickId] = { ...bricks[event.brickId]!, fitness: event.successRate };
        }
        const prev = sparklines[event.brickId] ?? [];
        sparklines[event.brickId] = [...prev, event.successRate].slice(-MAX_FORGE_SPARKLINE_POINTS);
        break;
      }
    }
  }

  const combined = [...state.forgeEvents, ...events];
  const forgeEvents =
    combined.length > MAX_FORGE_EVENTS ? combined.slice(-MAX_FORGE_EVENTS) : combined;

  return { forgeEvents, forgeBricks: bricks, forgeSparklines: sparklines };
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
