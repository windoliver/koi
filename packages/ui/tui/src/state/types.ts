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
export type TuiView = "agents" | "console" | "datasources" | "palette" | "sessions";

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
}

/** Create initial TUI state for a given admin URL. */
export function createInitialState(adminUrl: string): TuiState {
  return {
    view: "agents",
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
    };

/** Maximum messages kept in session memory (sliding window). */
export const MAX_SESSION_MESSAGES = 500;
