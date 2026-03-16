/**
 * TUI state types — pure data definitions for the terminal console.
 *
 * Re-exports ChatMessage and DashboardClientError from @koi/dashboard-client
 * to keep backward compatibility. TUI-specific state types defined here.
 */

import type {
  DashboardAgentSummary,
  DashboardEventBatch,
  DataSourceSummary,
  ForgeDashboardEvent,
  MonitorDashboardEvent,
} from "@koi/dashboard-types";

// Re-export shared types from dashboard-client
/** TUI-specific error alias for backward compat. */
export type {
  ChatMessage,
  DashboardClientError,
  DashboardClientError as TuiError,
} from "@koi/dashboard-client";

// ─── Session State ───────────────────────────────────────────────────

/** Active chat session state. */
export interface SessionState {
  readonly agentId: string;
  readonly sessionId: string;
  readonly messages: readonly import("@koi/dashboard-client").ChatMessage[];
  /** Buffered streaming tokens not yet flushed to messages. */
  readonly pendingText: string;
  readonly isStreaming: boolean;
}

// ─── View Types ──────────────────────────────────────────────────────

/** Which TUI view is currently active. */
export type TuiView =
  | "addons"
  | "agents"
  | "consent"
  | "console"
  | "datasources"
  | "forge"
  | "nameinput"
  | "palette"
  | "presetdetail"
  | "sessions"
  | "sourcedetail"
  | "splitpanes"
  | "welcome";

/** Panel zoom level — cycles with +/Esc. */
export type ZoomLevel = "normal" | "half" | "full";

/** Admin API connection state. */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

// ─── Application State ──────────────────────────────────────────────

/** A saved session entry for the session picker. */
export interface SessionPickerEntry {
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly connectedAt: number;
  readonly messageCount: number;
}

/** Forge brick summary for TUI display. */
export interface TuiBrickSummary {
  readonly name: string;
  readonly status: string;
  readonly fitness: number;
}

/** Preset info for the welcome screen. */
export interface PresetInfo {
  readonly id: string;
  readonly description: string;
  readonly nexusMode: string;
  readonly demoPack: string | undefined;
  readonly services: Readonly<Record<string, unknown>>;
  readonly stacks: Readonly<Record<string, boolean | undefined>>;
  readonly agentRoles?: readonly { readonly role: string; readonly description: string }[];
  readonly prompts?: readonly string[];
}

/** Complete TUI application state. Immutable — new object on every update. */
export interface TuiState {
  readonly view: TuiView;
  readonly agents: readonly DashboardAgentSummary[];
  readonly selectedAgentIndex: number;
  readonly activeSession: SessionState | null;
  readonly connectionStatus: ConnectionStatus;
  readonly error: import("@koi/dashboard-client").DashboardClientError | null;
  readonly adminUrl: string;
  /** Last received SSE sequence number for gap detection. */
  readonly lastEventSeq: number;
  /** Session picker entries. */
  readonly sessionPickerEntries: readonly SessionPickerEntry[];
  /** Whether the session picker is loading. */
  readonly sessionPickerLoading: boolean;
  /** Discovered data sources. */
  readonly dataSources: readonly DataSourceSummary[];
  /** Whether data sources are loading. */
  readonly dataSourcesLoading: boolean;
  /** Selected data source index. */
  readonly selectedDataSourceIndex: number;
  /** Source detail data for the detail view. */
  readonly sourceDetail: Readonly<Record<string, unknown>> | null;
  /** Whether source detail is loading. */
  readonly sourceDetailLoading: boolean;
  /** Pending consent data sources awaiting user approval. */
  readonly pendingConsent: readonly DataSourceSummary[] | undefined;
  /** Forge self-improvement events buffer. */
  readonly forgeEvents: readonly ForgeDashboardEvent[];
  /** Monitor anomaly events buffer. */
  readonly monitorEvents: readonly MonitorDashboardEvent[];
  /** Forge brick summaries by ID. */
  readonly forgeBricks: Readonly<Record<string, TuiBrickSummary>>;
  /** Forge sparkline data by brick ID. */
  readonly forgeSparklines: Readonly<Record<string, readonly number[]>>;
  /** Current zoom level for focused panel. */
  readonly zoomLevel: ZoomLevel;
  /** Available presets for the welcome screen. */
  readonly presets: readonly PresetInfo[];
  /** Selected preset index (welcome screen). */
  readonly selectedPresetIndex: number;
  /** Active preset detail being viewed. */
  readonly activePresetDetail: PresetInfo | null;
  /** Selected preset ID (after choosing from welcome screen). */
  readonly selectedPresetId: string | null;
  /** Agent name input by user during setup. */
  readonly agentNameInput: string;
  /** Selected add-on IDs during setup. */
  readonly selectedAddons: ReadonlySet<string>;
  /** Focused add-on index in the picker. */
  readonly addonFocusedIndex: number;
  /** Per-agent PTY output buffers (base64 chunks). */
  readonly ptyBuffers: Readonly<Record<string, readonly string[]>>;
  /** Per-agent sessions for split-pane mode. */
  readonly splitSessions: Readonly<Record<string, SessionState>>;
  /** Index of focused pane in split view. */
  readonly focusedPaneIndex: number;
}

/** App mode: welcome (no admin API) or boardroom (connected). */
export type TuiMode = "welcome" | "boardroom";

/** Create initial TUI state for a given admin URL and mode. */
export function createInitialState(adminUrl: string, mode: TuiMode = "boardroom"): TuiState {
  return {
    view: mode === "welcome" ? "welcome" : "agents",
    agents: [],
    selectedAgentIndex: 0,
    activeSession: null,
    connectionStatus: "disconnected",
    error: null,
    adminUrl,
    lastEventSeq: 0,
    sessionPickerEntries: [],
    sessionPickerLoading: false,
    dataSources: [],
    dataSourcesLoading: false,
    selectedDataSourceIndex: 0,
    sourceDetail: null,
    sourceDetailLoading: false,
    pendingConsent: undefined,
    forgeEvents: [],
    monitorEvents: [],
    forgeBricks: {},
    forgeSparklines: {},
    zoomLevel: "normal",
    presets: [],
    selectedPresetIndex: 0,
    activePresetDetail: null,
    selectedPresetId: null,
    agentNameInput: "",
    selectedAddons: new Set<string>(),
    addonFocusedIndex: 0,
    ptyBuffers: {},
    splitSessions: {},
    focusedPaneIndex: 0,
  };
}

// ─── Actions ─────────────────────────────────────────────────────────

/** Discriminated union of all state-changing actions. */
export type TuiAction =
  | { readonly kind: "set_view"; readonly view: TuiView }
  | {
      readonly kind: "set_agents";
      readonly agents: readonly DashboardAgentSummary[];
    }
  | { readonly kind: "select_agent"; readonly index: number }
  | { readonly kind: "set_session"; readonly session: SessionState | null }
  | { readonly kind: "append_tokens"; readonly text: string }
  | { readonly kind: "flush_tokens" }
  | {
      readonly kind: "add_message";
      readonly message: import("@koi/dashboard-client").ChatMessage;
    }
  | {
      readonly kind: "update_tool_result";
      readonly toolCallId: string;
      readonly result: string;
    }
  | {
      readonly kind: "set_connection_status";
      readonly status: ConnectionStatus;
    }
  | { readonly kind: "set_streaming"; readonly isStreaming: boolean }
  | {
      readonly kind: "set_error";
      readonly error: import("@koi/dashboard-client").DashboardClientError | null;
    }
  | {
      readonly kind: "apply_event_batch";
      readonly batch: DashboardEventBatch;
    }
  | {
      readonly kind: "set_session_picker";
      readonly entries: readonly SessionPickerEntry[];
      readonly loading: boolean;
    }
  | {
      readonly kind: "set_data_sources";
      readonly sources: readonly DataSourceSummary[];
    }
  | {
      readonly kind: "set_data_sources_loading";
      readonly loading: boolean;
    }
  | {
      readonly kind: "select_data_source";
      readonly index: number;
    }
  | {
      readonly kind: "set_source_detail";
      readonly detail: Readonly<Record<string, unknown>> | null;
    }
  | {
      readonly kind: "set_source_detail_loading";
      readonly loading: boolean;
    }
  | {
      readonly kind: "set_pending_consent";
      readonly sources: readonly DataSourceSummary[];
    }
  | { readonly kind: "clear_pending_consent" }
  | {
      readonly kind: "apply_forge_batch";
      readonly events: readonly ForgeDashboardEvent[];
    }
  | {
      readonly kind: "apply_monitor_event";
      readonly event: MonitorDashboardEvent;
    }
  | { readonly kind: "set_zoom_level"; readonly level: ZoomLevel }
  | { readonly kind: "cycle_zoom" }
  | {
      readonly kind: "set_presets";
      readonly presets: readonly PresetInfo[];
    }
  | { readonly kind: "select_preset"; readonly index: number }
  | {
      readonly kind: "set_active_preset_detail";
      readonly detail: PresetInfo | null;
    }
  | { readonly kind: "set_selected_preset_id"; readonly presetId: string }
  | { readonly kind: "set_agent_name_input"; readonly name: string }
  | { readonly kind: "toggle_addon"; readonly addonId: string }
  | { readonly kind: "set_addon_focused_index"; readonly index: number }
  | {
      readonly kind: "append_pty_data";
      readonly agentId: string;
      readonly data: string;
    }
  | { readonly kind: "clear_pty_buffer"; readonly agentId: string }
  | {
      readonly kind: "set_split_session";
      readonly agentId: string;
      readonly session: SessionState;
    }
  | {
      readonly kind: "remove_split_session";
      readonly agentId: string;
    }
  | {
      readonly kind: "append_split_tokens";
      readonly agentId: string;
      readonly text: string;
    }
  | {
      readonly kind: "flush_split_tokens";
      readonly agentId: string;
    }
  | {
      readonly kind: "set_focused_pane";
      readonly index: number;
    };

/** Maximum messages kept in session memory (sliding window). */
export const MAX_SESSION_MESSAGES = 500;
