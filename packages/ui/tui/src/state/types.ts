/**
 * TUI state types — all type definitions, discriminated unions, and constants
 * for the Ink-based terminal UI.
 *
 * This is a rendering concern only — not a data store or persistence layer.
 */

import type { EngineEvent } from "@koi/core/engine";
import type { ContentBlock } from "@koi/core/message";

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

/** Permission prompt data passed through from the engine. */
export interface PermissionPromptData {
  readonly toolName: string;
  readonly args: unknown;
  readonly message: string;
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
      readonly output?: string | undefined;
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
  | { readonly kind: "clear_messages" };
