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

/** Maximum sessions retained in the session picker (most recent first). */
export const MAX_SESSIONS = 50;

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
  | { readonly kind: "permission-prompt"; readonly prompt: PermissionPromptData }
  | { readonly kind: "session-picker" };

// ---------------------------------------------------------------------------
// Session & Metrics
// ---------------------------------------------------------------------------

/**
 * Cumulative token and cost metrics accumulated across all engine runs in a session.
 *
 * ## Stable contracts (do not repurpose in place):
 * - `turns` — user→agent round trips that involved at least one model call.
 *   Increments by 1 per `done` event when `EngineMetrics.turns > 0`.
 *   Zero-model-call completions (interrupted runs) do not increment this.
 * - `engineTurns` — total model calls across all runs, from `EngineMetrics.turns`.
 *   Includes tool-call loops and stop-retries within a single user request.
 *   Exposed in the status bar as `T{turns}·{engineTurns}` when amplified.
 *
 * Backward compatibility: `engineTurns` was added after initial rollout.
 * The reducer defaults it with `?? 0` when reading pre-migration state objects.
 */
export interface CumulativeMetrics {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turns: number;
  readonly engineTurns: number;
  /** Null until at least one turn provides costUsd. */
  readonly costUsd: number | null;
}

/** Session identity — set once by the host on session start. */
export interface SessionInfo {
  readonly modelName: string;
  readonly provider: string;
  readonly sessionName: string;
}

/** Summary of a saved session for the session picker. */
export interface SessionSummary {
  readonly id: string;
  readonly name: string;
  /** Unix timestamp in milliseconds. */
  readonly lastActivityAt: number;
  readonly messageCount: number;
  /** Short preview of the last message (may be truncated by the host). */
  readonly preview: string;
}

/** Agent processing state — derived from engine events, not WebSocket state. */
export type AgentStatus = "idle" | "processing" | "error";

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
      /** Tool execution result — always a string after reducer's capResult(). */
      readonly result?: string | undefined;
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
// Plan progress
// ---------------------------------------------------------------------------

/** Lightweight projection of a task for the progress display. */
export interface PlanTask {
  readonly id: string;
  readonly subject: string;
  readonly status: string;
  readonly activeForm?: string | undefined;
  readonly blockedBy?: string | undefined;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Complete TUI rendering state. */
export interface TuiState {
  readonly messages: readonly TuiMessage[];
  readonly activeView: TuiView;
  readonly modal: TuiModal | null;
  readonly connectionStatus: ConnectionStatus;
  readonly layoutTier: LayoutTier;
  readonly zoomLevel: number;
  // --- Status bar data ---
  /** Set by the host on session start; null before first session. */
  readonly sessionInfo: SessionInfo | null;
  /** Cumulative metrics accumulated across all turns. */
  readonly cumulativeMetrics: CumulativeMetrics;
  /** Processing state driven by engine events. */
  readonly agentStatus: AgentStatus;
  // --- Session picker data ---
  /** Saved sessions, sorted most-recent-first, capped at MAX_SESSIONS. */
  readonly sessions: readonly SessionSummary[];
  readonly slashQuery: string | null;
  /** Task board progress — null before first plan event. */
  readonly planTasks: readonly PlanTask[] | null;
  /** Count of tool calls currently in "running" state (avoids O(n) scan). */
  readonly runningToolCount: number;
  /** Whether tool result bodies are expanded (Ctrl+E toggle). */
  readonly toolsExpanded: boolean;
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
    }
  | {
      /** Set by the host on session start (model name, provider, session name). */
      readonly kind: "set_session_info";
      readonly modelName: string;
      readonly provider: string;
      readonly sessionName: string;
    }
  | {
      /** Injected by the host from persistence; TUI never performs I/O. */
      readonly kind: "set_session_list";
      readonly sessions: readonly SessionSummary[];
    }
  | { readonly kind: "set_slash_query"; readonly query: string | null }
  | { readonly kind: "toggle_tools_expanded" }
  | {
      /**
       * Replays loaded session history into the message list.
       * Injected by the host after resumeForSession; TUI never performs I/O.
       * Prepended before any live messages so the conversation reads top-to-bottom.
       * Only user/assistant messages are shown; tool entries are skipped.
       */
      readonly kind: "load_history";
      readonly messages: readonly {
        readonly senderId: string;
        readonly content: readonly ContentBlock[];
      }[];
    };
