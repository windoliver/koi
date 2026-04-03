/**
 * TUI state types — all type definitions, discriminated unions, and constants
 * for the OpenTUI-based terminal UI.
 *
 * This is a rendering concern only — not a data store or persistence layer.
 */

import type { JsonObject } from "@koi/core/common";
import type { EngineEvent } from "@koi/core/engine";
import type { ContentBlock } from "@koi/core/message";
import type { ApprovalDecision } from "@koi/core/middleware";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum messages retained after compaction. */
export const MAX_MESSAGES = 1000;

/** Message count that triggers compaction (hysteresis gap = 100). */
export const COMPACT_THRESHOLD = 1100;

/** Maximum characters stored per tool call output (tail-sliced). */
export const MAX_TOOL_OUTPUT_CHARS = 50_000;

// ---------------------------------------------------------------------------
// View & Modal
// ---------------------------------------------------------------------------

/** Screen-level views — one active at a time. */
export type TuiView = "conversation" | "sessions" | "doctor" | "help";

/** Risk level for permission prompts — computed by permissions middleware. */
export type PermissionRiskLevel = "low" | "medium" | "high";

/** Permission prompt data passed through from the engine.
 *  Field names align with @koi/core ApprovalRequest for zero-mapping DRY. */
export interface PermissionPromptData {
  /** Unique identifier for correlating response → resolve in the bridge. */
  readonly requestId: string;
  /** Tool identifier (matches ApprovalRequest.toolId). */
  readonly toolId: string;
  /** Tool call input (matches ApprovalRequest.input). */
  readonly input: JsonObject;
  /** Human-readable reason for the prompt (matches ApprovalRequest.reason). */
  readonly reason: string;
  /** Risk level indicator for visual emphasis. */
  readonly riskLevel: PermissionRiskLevel;
  /** Optional metadata from the ApprovalRequest. */
  readonly metadata?: JsonObject | undefined;
}

/** Transient overlay that preserves the underlying view. */
export type TuiModal =
  | { readonly kind: "command-palette"; readonly query: string }
  | { readonly kind: "permission-prompt"; readonly prompt: PermissionPromptData };

// ---------------------------------------------------------------------------
// Connection & Layout
// ---------------------------------------------------------------------------

/** WebSocket / SSE connection state. */
export type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

/** Terminal width tier — drives layout decisions in views. */
export type LayoutTier = "compact" | "normal" | "wide";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Tool call lifecycle status. */
export type ToolCallStatus = "running" | "complete" | "error";

/** A single block within an assistant message. */
export type TuiAssistantBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | {
      readonly kind: "tool_call";
      readonly callId: string;
      readonly toolName: string;
      readonly status: ToolCallStatus;
      /** Streamed argument JSON fragments (model generating the function call). */
      readonly args?: string | undefined;
      /** Tool execution result from tool_call_end (the actual tool response). */
      readonly result?: unknown;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
    };

/** Materialized message — reducer accumulates streaming deltas into these. */
export type TuiMessage =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly blocks: readonly ContentBlock[];
    }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly blocks: readonly TuiAssistantBlock[];
      readonly streaming: boolean;
    }
  | {
      readonly kind: "system";
      readonly id: string;
      readonly text: string;
    };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Complete TUI rendering state — flat, 6 fields. */
export interface TuiState {
  readonly messages: readonly TuiMessage[];
  readonly activeView: TuiView;
  readonly modal: TuiModal | null;
  readonly connectionStatus: ConnectionStatus;
  readonly layoutTier: LayoutTier;
  readonly zoomLevel: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** All actions the TUI reducer can handle. */
export type TuiAction =
  | { readonly kind: "engine_event"; readonly event: EngineEvent }
  | {
      readonly kind: "add_user_message";
      readonly id: string;
      readonly blocks: readonly ContentBlock[];
    }
  | { readonly kind: "set_view"; readonly view: TuiView }
  | { readonly kind: "set_modal"; readonly modal: TuiModal | null }
  | { readonly kind: "set_connection_status"; readonly status: ConnectionStatus }
  | { readonly kind: "set_layout"; readonly tier: LayoutTier }
  | { readonly kind: "set_zoom"; readonly level: number }
  | {
      readonly kind: "add_error";
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: "clear_messages" }
  | {
      readonly kind: "permission_response";
      readonly requestId: string;
      readonly decision: ApprovalDecision;
    };
