/**
 * Immutable state store for the TUI application.
 *
 * Single state object, pure reducer, explicit render trigger.
 * No magic, no subscriptions, no external dependencies.
 */

import type { ChatMessage } from "@koi/dashboard-client";
import type { DashboardAgentSummary, ForgeDashboardEvent } from "@koi/dashboard-types";
import {
  isAgentEvent,
  isChannelEvent,
  isForgeEvent,
  isGatewayEvent,
  isHarnessEvent,
  isMonitorEvent,
  isNexusEvent,
  isSchedulerEvent,
  isSkillEvent,
  isSystemEvent,
  isTaskBoardEvent,
  isTemporalEvent,
} from "@koi/dashboard-types";
import {
  addGovernanceApproval,
  addGovernanceViolation,
  computeDagLayout,
  reduceChannels,
  reduceGateway,
  reduceHarness,
  reduceNexus,
  reduceScheduler,
  reduceSkills,
  reduceSystem,
  reduceTaskBoard,
  reduceTemporal,
  removeGovernanceApproval,
} from "./domain-reducers.js";
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

      // Domain sub-state accumulators
      let skillsView = state.skillsView;
      let channelsView = state.channelsView;
      let systemView = state.systemView;
      let nexusView = state.nexusView;
      let gatewayView = state.gatewayView;
      let temporalView = state.temporalView;
      let schedulerView = state.schedulerView;
      let taskBoardView = state.taskBoardView;
      let harnessView = state.harnessView;

      for (const event of batch.events) {
        if (isAgentEvent(event)) {
          updatedAgents = state.agents;
        }
        if (isForgeEvent(event)) {
          forgeEvents.push(event);
        }
        if (isSkillEvent(event)) {
          skillsView = reduceSkills(skillsView, event);
        }
        if (isChannelEvent(event)) {
          channelsView = reduceChannels(channelsView, event);
        }
        if (isSystemEvent(event)) {
          systemView = reduceSystem(systemView, event);
        }
        if (isNexusEvent(event)) {
          nexusView = reduceNexus(nexusView, event);
        }
        if (isGatewayEvent(event)) {
          gatewayView = reduceGateway(gatewayView, event);
        }
        if (isTemporalEvent(event)) {
          temporalView = reduceTemporal(temporalView, event);
        }
        if (isSchedulerEvent(event)) {
          schedulerView = reduceScheduler(schedulerView, event);
        }
        if (isTaskBoardEvent(event)) {
          taskBoardView = reduceTaskBoard(taskBoardView, event);
        }
        if (isHarnessEvent(event)) {
          harnessView = reduceHarness(harnessView, event);
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
        skillsView,
        channelsView,
        systemView,
        nexusView,
        gatewayView,
        temporalView,
        schedulerView,
        taskBoardView,
        harnessView,
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

    // ─── Domain event actions ──────────────────────────────────────────

    case "apply_skill_event":
      return { ...state, skillsView: reduceSkills(state.skillsView, action.event) };

    case "apply_channel_event":
      return { ...state, channelsView: reduceChannels(state.channelsView, action.event) };

    case "apply_system_event":
      return { ...state, systemView: reduceSystem(state.systemView, action.event) };

    case "apply_nexus_event":
      return { ...state, nexusView: reduceNexus(state.nexusView, action.event) };

    case "apply_gateway_event":
      return { ...state, gatewayView: reduceGateway(state.gatewayView, action.event) };

    case "apply_temporal_event":
      return { ...state, temporalView: reduceTemporal(state.temporalView, action.event) };

    case "apply_scheduler_event":
      return { ...state, schedulerView: reduceScheduler(state.schedulerView, action.event) };

    case "apply_taskboard_event":
      return { ...state, taskBoardView: reduceTaskBoard(state.taskBoardView, action.event) };

    case "apply_harness_event":
      return { ...state, harnessView: reduceHarness(state.harnessView, action.event) };

    case "set_capabilities":
      return { ...state, capabilities: action.capabilities };

    // ─── Domain data-fetch actions ─────────────────────────────────────

    case "set_gateway_topology":
      return { ...state, gatewayView: { ...state.gatewayView, topology: action.topology } };

    case "set_temporal_health":
      return { ...state, temporalView: { ...state.temporalView, health: action.health } };

    case "set_temporal_workflows":
      return {
        ...state,
        temporalView: {
          ...state.temporalView,
          workflows: action.workflows,
          selectedWorkflowIndex: Math.min(
            state.temporalView.selectedWorkflowIndex,
            Math.max(0, action.workflows.length - 1),
          ),
        },
      };

    case "set_temporal_workflow_detail":
      return { ...state, temporalView: { ...state.temporalView, workflowDetail: action.detail } };

    case "select_temporal_workflow":
      return {
        ...state,
        temporalView: {
          ...state.temporalView,
          selectedWorkflowIndex: Math.max(
            0,
            Math.min(action.index, state.temporalView.workflows.length - 1),
          ),
        },
      };

    case "set_scheduler_stats":
      return { ...state, schedulerView: { ...state.schedulerView, stats: action.stats } };

    case "set_scheduler_tasks":
      return { ...state, schedulerView: { ...state.schedulerView, tasks: action.tasks } };

    case "set_scheduler_schedules":
      return { ...state, schedulerView: { ...state.schedulerView, schedules: action.schedules } };

    case "set_scheduler_dead_letters":
      return { ...state, schedulerView: { ...state.schedulerView, deadLetters: action.entries } };

    case "set_taskboard_snapshot": {
      const { snapshot } = action;
      const prev = state.taskBoardView;
      const needsRelayout =
        prev.snapshot === null ||
        snapshot.nodes.length !== prev.layoutNodeCount ||
        snapshot.edges.length !== prev.layoutEdgeCount;
      const layout = needsRelayout
        ? computeDagLayout(snapshot.nodes, snapshot.edges)
        : prev.cachedLayout;
      return {
        ...state,
        taskBoardView: {
          ...prev,
          snapshot,
          cachedLayout: layout,
          layoutNodeCount: snapshot.nodes.length,
          layoutEdgeCount: snapshot.edges.length,
        },
      };
    }

    case "set_harness_status":
      return { ...state, harnessView: { ...state.harnessView, status: action.status } };

    case "set_harness_checkpoints":
      return { ...state, harnessView: { ...state.harnessView, checkpoints: action.checkpoints } };

    case "set_middleware_chain":
      return {
        ...state,
        middlewareView: { ...state.middlewareView, chain: action.chain, loading: false },
      };

    case "set_middleware_loading":
      return { ...state, middlewareView: { ...state.middlewareView, loading: action.loading } };

    case "set_process_tree":
      return {
        ...state,
        processTreeView: { ...state.processTreeView, snapshot: action.snapshot, loading: false },
      };

    case "set_process_tree_loading":
      return { ...state, processTreeView: { ...state.processTreeView, loading: action.loading } };

    case "set_agent_procfs":
      return {
        ...state,
        agentProcfsView: { ...state.agentProcfsView, procfs: action.procfs, loading: false },
      };

    case "set_agent_procfs_loading":
      return { ...state, agentProcfsView: { ...state.agentProcfsView, loading: action.loading } };

    // ─── Governance actions ────────────────────────────────────────────

    case "add_governance_approval":
      return {
        ...state,
        governanceView: addGovernanceApproval(state.governanceView, action.approval),
      };

    case "remove_governance_approval":
      return {
        ...state,
        governanceView: removeGovernanceApproval(state.governanceView, action.id),
      };

    case "add_governance_violation":
      return {
        ...state,
        governanceView: addGovernanceViolation(state.governanceView, action.violation),
      };

    case "select_governance_item":
      return {
        ...state,
        governanceView: {
          ...state.governanceView,
          selectedIndex: Math.max(
            0,
            Math.min(action.index, state.governanceView.pendingApprovals.length - 1),
          ),
        },
      };

    case "scroll_domain_view": {
      const { domain, offset } = action;
      switch (domain) {
        case "skills":
          return {
            ...state,
            skillsView: { ...state.skillsView, scrollOffset: Math.max(0, offset) },
          };
        case "channels":
          return {
            ...state,
            channelsView: { ...state.channelsView, scrollOffset: Math.max(0, offset) },
          };
        case "system":
          return {
            ...state,
            systemView: { ...state.systemView, scrollOffset: Math.max(0, offset) },
          };
        case "nexus":
          return { ...state, nexusView: { ...state.nexusView, scrollOffset: Math.max(0, offset) } };
        case "gateway":
          return {
            ...state,
            gatewayView: { ...state.gatewayView, scrollOffset: Math.max(0, offset) },
          };
        case "temporal":
          return {
            ...state,
            temporalView: { ...state.temporalView, scrollOffset: Math.max(0, offset) },
          };
        case "scheduler":
          return {
            ...state,
            schedulerView: { ...state.schedulerView, scrollOffset: Math.max(0, offset) },
          };
        case "taskboard":
          return {
            ...state,
            taskBoardView: { ...state.taskBoardView, scrollOffset: Math.max(0, offset) },
          };
        case "harness":
          return {
            ...state,
            harnessView: { ...state.harnessView, scrollOffset: Math.max(0, offset) },
          };
        case "governance":
          return {
            ...state,
            governanceView: { ...state.governanceView, scrollOffset: Math.max(0, offset) },
          };
        case "middleware":
          return {
            ...state,
            middlewareView: { ...state.middlewareView, scrollOffset: Math.max(0, offset) },
          };
        case "processtree":
          return {
            ...state,
            processTreeView: { ...state.processTreeView, scrollOffset: Math.max(0, offset) },
          };
        case "agentprocfs":
          return {
            ...state,
            agentProcfsView: { ...state.agentProcfsView, scrollOffset: Math.max(0, offset) },
          };
        case "cost":
          return { ...state, costView: { ...state.costView, scrollOffset: Math.max(0, offset) } };
        default:
          return state;
      }
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
      case "brick_deprecated": {
        const existing = bricks[event.brickId];
        if (existing !== undefined) {
          bricks[event.brickId] = {
            ...existing,
            status: "deprecated",
            fitness: event.fitnessOriginal,
          };
        }
        break;
      }
      case "brick_promoted": {
        const existing = bricks[event.brickId];
        if (existing !== undefined) {
          bricks[event.brickId] = {
            ...existing,
            status: "promoted",
            fitness: event.fitnessOriginal,
          };
        }
        break;
      }
      case "brick_quarantined": {
        const existing = bricks[event.brickId];
        if (existing !== undefined) {
          bricks[event.brickId] = { ...existing, status: "quarantined" };
        }
        break;
      }
      case "fitness_flushed": {
        const existing = bricks[event.brickId];
        if (existing !== undefined) {
          bricks[event.brickId] = { ...existing, fitness: event.successRate };
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
