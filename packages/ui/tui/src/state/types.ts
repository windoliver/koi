/**
 * TUI state types — pure data definitions for the terminal console.
 *
 * All types are readonly and immutable per Koi conventions.
 */

import type { DashboardAgentSummary, DashboardEventBatch } from "@koi/dashboard-types";

// ─── Error Types ─────────────────────────────────────────────────────

/** All expected failure modes for the TUI client. */
export type TuiError =
  | {
      readonly kind: "connection_refused";
      readonly url: string;
    }
  | {
      readonly kind: "auth_failed";
      readonly message: string;
    }
  | {
      readonly kind: "stream_dropped";
      readonly sessionId: string;
    }
  | {
      readonly kind: "agent_terminated";
      readonly agentId: string;
    }
  | {
      readonly kind: "timeout";
      readonly operation: string;
      readonly ms: number;
    }
  | {
      readonly kind: "api_error";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "unexpected";
      readonly cause: unknown;
    };

// ─── Chat Types ──────────────────────────────────────────────────────

/** A single message in the agent console conversation. */
export type ChatMessage =
  | {
      readonly kind: "user";
      readonly text: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "assistant";
      readonly text: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "tool_call";
      readonly name: string;
      readonly args: string;
      readonly result: string | undefined;
      readonly timestamp: number;
    }
  | {
      readonly kind: "lifecycle";
      readonly event: string;
      readonly timestamp: number;
    };

/** Active chat session state. */
export interface SessionState {
  readonly agentId: string;
  readonly sessionId: string;
  readonly messages: readonly ChatMessage[];
  /** Buffered streaming tokens not yet flushed to messages. */
  readonly pendingText: string;
  readonly isStreaming: boolean;
}

// ─── View Types ──────────────────────────────────────────────────────

/** Which TUI view is currently active. */
export type TuiView = "agents" | "console" | "palette";

/** Admin API connection state. */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

// ─── Application State ──────────────────────────────────────────────

/** Complete TUI application state. Immutable — new object on every update. */
export interface TuiState {
  readonly view: TuiView;
  readonly agents: readonly DashboardAgentSummary[];
  readonly selectedAgentIndex: number;
  readonly activeSession: SessionState | null;
  readonly connectionStatus: ConnectionStatus;
  readonly error: TuiError | null;
  readonly adminUrl: string;
  /** Last received SSE sequence number for gap detection. */
  readonly lastEventSeq: number;
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
      readonly message: ChatMessage;
    }
  | {
      readonly kind: "set_connection_status";
      readonly status: ConnectionStatus;
    }
  | { readonly kind: "set_streaming"; readonly isStreaming: boolean }
  | { readonly kind: "set_error"; readonly error: TuiError | null }
  | {
      readonly kind: "apply_event_batch";
      readonly batch: DashboardEventBatch;
    };

/** Maximum messages kept in session memory (sliding window). */
export const MAX_SESSION_MESSAGES = 500;
