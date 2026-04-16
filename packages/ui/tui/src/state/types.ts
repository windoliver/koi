/**
 * TUI state types — all type definitions, discriminated unions, and constants
 * for the OpenTUI-based terminal UI.
 *
 * This is a rendering concern only — not a data store or persistence layer.
 */

import type { JsonObject } from "@koi/core/common";
import type { CostBreakdown } from "@koi/core/cost-tracker";
import type { EngineEvent } from "@koi/core/engine";
import type { ContentBlock, InboundMessage } from "@koi/core/message";
import type { ApprovalDecision } from "@koi/core/middleware";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum messages retained after compaction. */
export const MAX_MESSAGES = 1000;

/** Message count that triggers compaction (hysteresis gap = 100). */
export const COMPACT_THRESHOLD = 1100;

/**
 * Maximum bytes stored per tool result value (1 MB).
 * Results exceeding this are stored with truncated: true.
 */
export const MAX_TOOL_RESULT_BYTES = 1_048_576;

/** Maximum sessions retained in the session picker (most recent first). */
export const MAX_SESSIONS = 50;

// ---------------------------------------------------------------------------
// View & Modal
// ---------------------------------------------------------------------------

/** Screen-level views — one active at a time. */
export type TuiView =
  | "conversation"
  | "sessions"
  | "doctor"
  | "help"
  | "agents"
  | "trajectory"
  | "cost"
  | "mcp"
  | "plugins";

/** MCP server status entry for the /mcp view. */
export interface McpServerInfo {
  readonly name: string;
  readonly status: "connected" | "needs-auth" | "error" | "pending" | "auth-pending-restart";
  readonly toolCount: number;
  readonly detail: string | undefined;
}

// ---------------------------------------------------------------------------
// Plugin summary (populated once at startup — static for session lifetime)
// ---------------------------------------------------------------------------

export interface PluginSummaryEntry {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly source: "bundled" | "user" | "managed";
}

export interface PluginSummaryError {
  readonly plugin: string;
  readonly error: string;
}

export interface PluginSummary {
  readonly loaded: readonly PluginSummaryEntry[];
  readonly errors: readonly PluginSummaryError[];
}

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
  /** Whether persistent "always" approval is available (store configured + user authenticated). */
  readonly permanentAvailable?: boolean | undefined;
  /**
   * 1-indexed position of this prompt in the bridge's pending queue at the
   * moment it was dispatched. `undefined` when there is exactly one prompt
   * in flight. Used by the PermissionPrompt component to render a
   * "(1 of N)" hint so users can tell that a follow-up prompt after `y`
   * is a *next* queued tool call, not a duplicate of the same call. (#1759)
   */
  readonly queuePosition?: number | undefined;
  /** Total number of pending prompts at the moment of dispatch. */
  readonly queueDepth?: number | undefined;
  /**
   * Monotonically-increasing counter of permission prompts the bridge has
   * shown since process start. Distinct from `queuePosition` because the
   * engine often serializes tool calls so the bridge sees them
   * sequentially rather than queued — `queueDepth` is always 1 in that
   * case and gives the user no way to tell that the next prompt is a
   * NEW tool call rather than a re-render of the previous one. The
   * sequence number is always rendered (e.g. `#7 → #8`) so consecutive
   * prompts visibly differ. (#1759)
   */
  readonly sequenceNumber?: number | undefined;
}

/** Transient overlay that preserves the underlying view. */
export type TuiModal =
  | { readonly kind: "command-palette"; readonly query: string }
  | { readonly kind: "permission-prompt"; readonly prompt: PermissionPromptData }
  | { readonly kind: "session-picker" }
  | { readonly kind: "session-rename" };

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
  /**
   * Stable identifier for the current TUI process's session.
   * Used by the status bar (short prefix) and the post-quit resume
   * hint so the user can pick the session back up with
   * `koi start --resume <id>`.
   */
  readonly sessionId: string;
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
// Tool result storage
// ---------------------------------------------------------------------------

/**
 * Structured tool result stored in TUI state.
 *
 * Stores the raw execution output with a size cap and truncation signal.
 * The cap (MAX_TOOL_RESULT_BYTES) prevents unbounded memory growth in long
 * sessions. `truncated: true` signals to the view that a "show more" affordance
 * is appropriate.
 *
 * The view layer (tool-display.ts) is responsible for serialization and
 * rendering — never the reducer.
 */
export interface ToolResultData {
  /** Raw tool execution output — typed as unknown to preserve structure. */
  readonly value: unknown;
  /** Approximate byte size of the serialized value (pre-cap). */
  readonly byteSize: number;
  /** True when the value was truncated to fit MAX_TOOL_RESULT_BYTES. */
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Tool call lifecycle status. */
export type ToolCallStatus = "running" | "complete" | "error";

/** Lifecycle status of a spawned agent. */
export type SpawnStatus = "running" | "complete" | "failed";

/** Final stats for a completed spawn. */
export interface SpawnStats {
  readonly turns: number;
  readonly toolCalls: number;
  readonly durationMs: number;
}

/**
 * Live progress for an actively running spawned agent.
 * Stored outside the messages array so frequent updates (one per sub-tool)
 * don't trigger full message-list re-renders.
 */
export interface SpawnProgress {
  readonly agentName: string;
  readonly description: string;
  readonly startedAt: number;
  /** Most recent sub-tool being executed (live activity line). */
  readonly currentTool?: string | undefined;
}

/** Historical record for a spawn that reached a terminal state (#1792). */
export interface SpawnRecord {
  readonly agentId: string;
  readonly agentName: string;
  readonly description: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly outcome: "complete" | "failed";
}

/** Maximum number of finished spawns retained for the /agents view. */
export const MAX_FINISHED_SPAWNS = 20;

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
      /** Tool execution output — populated by the tool_result engine event. */
      readonly result?: ToolResultData | undefined;
      /** Unix timestamp (ms) when the tool call started — for elapsed/duration display. */
      readonly startedAt?: number | undefined;
      /** Duration in ms from startedAt to tool_call_end — always-visible chip (#9). */
      readonly durationMs?: number | undefined;
    }
  | {
      /** Inline block for a spawned sub-agent. Populated by spawn_requested event. */
      readonly kind: "spawn_call";
      readonly agentId: string;
      readonly agentName: string;
      readonly description: string;
      readonly status: SpawnStatus;
      /** Populated when status transitions to "complete" or "failed". */
      readonly stats?: SpawnStats | undefined;
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
  /**
   * Per-block expand state for tool results (Decision 8A).
   * Collapsed by default (empty set). Expand individual tools by adding their
   * callId; Ctrl+E expand-all populates with all current callIds.
   */
  readonly expandedToolCallIds: ReadonlySet<string>;
  /**
   * Per-block full-body expand state (#7 N-line truncation).
   * When a callId is NOT in this set, the body is truncated to N lines.
   * When in this set, all lines are shown. Populated on "show more" click.
   */
  readonly expandedBodyToolCallIds: ReadonlySet<string>;
  /**
   * Live progress for actively running spawned agents (Decision 15A).
   * Keyed by agentId. Stored separately from messages so frequent
   * task_progress updates don't re-render the entire message list.
   * Entries are removed when the agent reaches a terminal status.
   */
  readonly activeSpawns: ReadonlyMap<string, SpawnProgress>;
  /**
   * Rolling history of spawned agents that reached a terminal state in the
   * current session (#1792). Most-recent-first, capped at MAX_FINISHED_SPAWNS.
   * Used by the /agents view to surface recently-completed spawns that would
   * otherwise disappear from activeSpawns the moment they finish.
   */
  readonly finishedSpawns: readonly SpawnRecord[];
  /** Max context tokens for the current model — used for context % indicator (#17). */
  readonly maxContextTokens: number | null;
  /** Live retry countdown — set by the bridge when the engine retries (#20). */
  readonly retryState: { readonly countdownSec: number; readonly attempt: number } | null;
  /** Current agent nesting depth — 0 for root agent (#4). */
  readonly agentDepth: number;
  /** Sibling info for sub-agents: which agent out of how many (#4). */
  readonly siblingInfo: { readonly current: number; readonly total: number } | null;
  /** @-mention file path query — null when no overlay active (#10). */
  readonly atQuery: string | null;
  /** File path completions for @-mention overlay (#10). */
  readonly atResults: readonly string[];
  /** Whether tool result bodies are expanded (Ctrl+E toggle). */
  readonly toolsExpanded: boolean;
  /** Trajectory steps for /trajectory view — injected by host via set_trajectory_data. */
  readonly trajectorySteps: readonly TrajectoryStepSummary[];
  /** Monotonic counter — incrementing resumes auto-follow in MessageList. */
  readonly resumeFollowCounter: number;
  /** Audit entries from decision ledger — injected alongside trajectory steps. */
  readonly auditEntries: readonly LedgerAuditEntry[];
  /** Per-lane source status from decision ledger (e.g. "present", "missing"). */
  readonly ledgerSources: LedgerSources | null;
  /** One-line run report summary, when a ReportStore is configured. */
  readonly runReportSummary: string | null;
  /** Whether thinking/reasoning blocks are visible. Default: true. Toggle via /thinking. */
  readonly showThinking: boolean;
  /** MCP server status list — populated by host on /mcp command. */
  readonly mcpServers: readonly McpServerInfo[];
  /** Plugin discovery results — null before runtime reports. */
  readonly pluginSummary: PluginSummary | null;
  /** Cost breakdown injected by host — null before first cost data push. */
  readonly costBreakdown: CostBreakdown | null;
  /** Token throughput rate (tokens/sec) — null before first data push. */
  readonly tokenRate: { readonly inputPerSecond: number; readonly outputPerSecond: number } | null;
}

/** Summary of a trajectory step for display in the TUI /trajectory view. */
export interface TrajectoryStepSummary {
  /** Step index in the trajectory. */
  readonly stepIndex: number;
  /** Turn index: 0 = session setup (pre-agent), 1+ = user turns (1-based). */
  readonly turnIndex: number;
  /** Step kind: "model_call", "tool_call", "system", etc. */
  readonly kind: string;
  /** Tool name (for tool steps) or model identifier (for model steps). */
  readonly identifier: string;
  /** Duration in milliseconds. */
  readonly durationMs: number | undefined;
  /** Outcome: "success", "failure", "retry", or undefined. */
  readonly outcome: string | undefined;
  /** Timestamp of the step (epoch ms). */
  readonly timestamp: number;
  /** Request content — tool arguments (JSON) or model prompt text. */
  readonly requestText: string | undefined;
  /** Response content — tool result or model output text. */
  readonly responseText: string | undefined;
  /** Error content when outcome is "failure". */
  readonly errorText: string | undefined;
  /** Token metrics for model steps. */
  readonly tokens: TrajectoryTokenMetrics | undefined;
  /** Middleware span metadata (hook name, phase, nextCalled, decision). */
  readonly middlewareSpan: TrajectoryMiddlewareSpan | undefined;
}

/** Metadata for a middleware span trajectory step. */
export interface TrajectoryMiddlewareSpan {
  /** Which hook fired: "wrapModelCall", "wrapToolCall", "wrapModelStream". */
  readonly hook: string | undefined;
  /** Middleware phase: "intercept", "resolve", "observe". */
  readonly phase: string | undefined;
  /** Whether next() was called (false = middleware blocked the chain). */
  readonly nextCalled: boolean | undefined;
  /** Structured decisions reported by the middleware via ctx.reportDecision(). */
  readonly decisions: readonly JsonObject[] | undefined;
}

/** Token metrics for a single trajectory step. */
export interface TrajectoryTokenMetrics {
  readonly promptTokens: number | undefined;
  readonly completionTokens: number | undefined;
  readonly cachedTokens: number | undefined;
}

/** Audit entry from the decision ledger, mapped for TUI display. */
export interface LedgerAuditEntry {
  readonly timestamp: number;
  readonly kind: string;
  readonly summary: string;
}

/** Per-lane source status from the decision ledger. */
export interface LedgerSources {
  readonly trajectory: string;
  readonly audit: string;
  readonly report: string;
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
  | { readonly kind: "set_mcp_status"; readonly servers: readonly McpServerInfo[] }
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
      /**
       * Dispatched by the permission bridge when a tool's approval has been
       * granted and the engine is about to begin real execution. The reducer
       * stamps `startedAt = Date.now()` on the tool-call block identified by
       * `callId`, so the TUI's elapsed-time counter reflects actual tool
       * runtime — not the time the user spent reading the prompt.
       *
       * Fires only for the ask → approve path; allow / cached-allow paths
       * already have an accurate startedAt from tool_call_start because there
       * is no user-facing delay on those paths.
       */
      readonly kind: "tool_execution_started";
      readonly callId: string;
    }
  | {
      /** Set by the host on session start (model name, provider, session name, session id). */
      readonly kind: "set_session_info";
      readonly modelName: string;
      readonly provider: string;
      readonly sessionName: string;
      readonly sessionId: string;
      /** Max context tokens for the model — used for context % indicator (#17). */
      readonly maxTokens?: number | undefined;
    }
  | {
      /**
       * Rehydrate the visible message list from a replayed session
       * transcript. Dispatched once at TUI startup when the user passes
       * `koi tui --resume <id>`. The reducer converts each InboundMessage
       * to the TUI-local TuiMessage shape — conversion lives in the TUI
       * package so InboundMessage never leaks into the reducer output.
       */
      readonly kind: "rehydrate_messages";
      readonly messages: readonly InboundMessage[];
    }
  | {
      /** Injected by the host from persistence; TUI never performs I/O. */
      readonly kind: "set_session_list";
      readonly sessions: readonly SessionSummary[];
    }
  | {
      /**
       * Mark a spawned agent as terminated with an explicit outcome.
       * Dispatched by the host spawn-event bridge — the engine's ProcessState
       * only has a single "terminated" value, so the TUI needs a dedicated
       * action to preserve complete vs failed for rendering (#1583 round 6).
       */
      readonly kind: "set_spawn_terminal";
      readonly agentId: string;
      readonly outcome: "complete" | "failed";
    }
  | { readonly kind: "set_slash_query"; readonly query: string | null }
  | {
      /** Expand a single tool call block by callId. No-op if already expanded. */
      readonly kind: "expand_tool";
      readonly callId: string;
    }
  | {
      /** Collapse a single tool call block by callId. No-op if not expanded. */
      readonly kind: "collapse_tool";
      readonly callId: string;
    }
  | {
      /**
       * Ctrl+E global toggle: if any tool call is not in expandedToolCallIds,
       * expand all; if all are expanded, collapse all (clear set).
       */
      readonly kind: "toggle_all_tools_expanded";
    }
  | {
      /** Expand tool body to show all lines (overrides N-line cap, #7). */
      readonly kind: "expand_tool_body";
      readonly callId: string;
    }
  | {
      /** Collapse tool body back to N-line truncated view (#7). */
      readonly kind: "collapse_tool_body";
      readonly callId: string;
    }
  | {
      /** Set or clear the retry countdown (#20). countdown null = clear. */
      readonly kind: "set_retry_state";
      readonly countdown: number | null;
      readonly attempt?: number | undefined;
    }
  | {
      /** Set agent nesting context for subagent footer (#4). */
      readonly kind: "set_agent_context";
      readonly depth: number;
      readonly siblingInfo?: { readonly current: number; readonly total: number } | undefined;
    }
  | { readonly kind: "set_at_query"; readonly query: string | null }
  | { readonly kind: "set_at_results"; readonly results: readonly string[] }
  | { readonly kind: "resume_follow" }
  | { readonly kind: "toggle_thinking" }
  | {
      /** Injected by the host with trajectory + ledger data for /trajectory view. */
      readonly kind: "set_trajectory_data";
      readonly steps: readonly TrajectoryStepSummary[];
      readonly auditEntries?: readonly LedgerAuditEntry[] | undefined;
      readonly ledgerSources?: LedgerSources | undefined;
      readonly runReportSummary?: string | undefined;
    }
  | {
      /**
       * Replays loaded session history into the message list.
       * Injected by the host after resumeForSession; TUI never performs I/O.
       * Prepended before any live messages so the conversation reads top-to-bottom.
       * Only user/assistant text messages are shown; tool entries,
       * privileged system:* senders, metadata.toolCalls placeholders,
       * and resumedSystemRole-tagged user entries are all filtered
       * out — the reducer needs `metadata` visibility to apply those
       * rules uniformly with `rehydrate_messages`.
       */
      readonly kind: "load_history";
      readonly messages: readonly InboundMessage[];
    }
  | {
      /** Injected by the host with cost breakdown data for the cost dashboard view. */
      readonly kind: "set_cost_breakdown";
      readonly breakdown: CostBreakdown;
      readonly tokenRate?:
        | { readonly inputPerSecond: number; readonly outputPerSecond: number }
        | undefined;
    }
  | {
      readonly kind: "set_plugin_summary";
      readonly summary: PluginSummary;
    };
