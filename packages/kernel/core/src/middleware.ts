/**
 * Middleware contract — sole interposition layer for model/tool calls.
 */

import type { ChannelStatus } from "./channel.js";
import type { JsonObject } from "./common.js";
import type {
  ComponentProvider,
  RunId,
  SessionId,
  ToolCallId,
  ToolDescriptor,
  TurnId,
} from "./ecs.js";
import type { KoiErrorCode } from "./errors.js";
import type { InboundMessage } from "./message.js";
import type { ModelContentBlock, ModelStopReason } from "./model-adapter.js";

export interface SessionContext {
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  /** Stable ID for the copilot conversation that spans multiple engine sessions.
   *  Set once at conversation start, reused across all runtime.run() calls.
   *  When absent, sessionId is used as the fallback scope. */
  readonly conversationId?: string;
  /** Authenticated user identity. Injected by L1 when provided in CreateKoiOptions. */
  readonly userId?: string;
  /** Injected by L1 at session start — package name of the active channel adapter (e.g. "@koi/channel-telegram"). */
  readonly channelId?: string;
  readonly metadata: JsonObject;
}

export interface TurnContext {
  readonly session: SessionContext;
  readonly turnIndex: number;
  readonly turnId: TurnId;
  readonly messages: readonly InboundMessage[];
  readonly metadata: JsonObject;
  readonly signal?: AbortSignal | undefined;
  readonly requestApproval?: ApprovalHandler;
  /** Optional callback to notify channels of turn status. Injected by L1 if configured. */
  readonly sendStatus?: (status: ChannelStatus) => Promise<void>;
}

export interface ModelRequest {
  readonly messages: readonly InboundMessage[];
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly metadata?: JsonObject;
  /** Propagated abort signal — adapters should compose with their own timeout. */
  readonly signal?: AbortSignal | undefined;
  /** Tool descriptors available for this call. Injected by L1; middleware may filter. */
  readonly tools?: readonly ToolDescriptor[];
}

export interface ModelResponse {
  readonly content: string;
  readonly model: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number | undefined;
    readonly cacheWriteTokens?: number | undefined;
  };
  readonly metadata?: JsonObject;
  /** Why the model stopped generating. Absent for legacy callers. */
  readonly stopReason?: ModelStopReason | undefined;
  /** Provider-specific response identifier for debugging/audit. */
  readonly responseId?: string | undefined;
  /** Rich content blocks when the model returns tool calls or thinking. */
  readonly richContent?: readonly ModelContentBlock[] | undefined;
}

export type ModelHandler = (request: ModelRequest) => Promise<ModelResponse>;

export type ModelChunk =
  | { readonly kind: "text_delta"; readonly delta: string }
  | { readonly kind: "thinking_delta"; readonly delta: string }
  | { readonly kind: "tool_call_start"; readonly toolName: string; readonly callId: ToolCallId }
  | { readonly kind: "tool_call_delta"; readonly callId: ToolCallId; readonly delta: string }
  | { readonly kind: "tool_call_end"; readonly callId: ToolCallId }
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly code?: KoiErrorCode | undefined;
      readonly retryable?: boolean | undefined;
      readonly retryAfterMs?: number | undefined;
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
    }
  | { readonly kind: "done"; readonly response: ModelResponse };

export type ModelStreamHandler = (request: ModelRequest) => AsyncIterable<ModelChunk>;

export interface ToolRequest {
  readonly toolId: string;
  readonly input: JsonObject;
  readonly metadata?: JsonObject;
  readonly signal?: AbortSignal | undefined;
}

export interface ToolResponse {
  readonly output: unknown;
  readonly metadata?: JsonObject;
}

export type ToolHandler = (request: ToolRequest) => Promise<ToolResponse>;

export interface ApprovalRequest {
  readonly toolId: string;
  readonly input: JsonObject;
  readonly reason: string;
  readonly metadata?: JsonObject;
}

export type ApprovalDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "modify"; readonly updatedInput: JsonObject }
  | { readonly kind: "deny"; readonly reason: string };

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/**
 * A middleware's self-description for the LLM.
 *
 * Good descriptions are concise, factual, and actionable:
 *   label: "permissions", description: "Tools requiring approval: fs:write, shell:exec"
 *   label: "budget", description: "Token budget: 8,500 of 10,000 remaining"
 *   label: "guardrails", description: "Output must conform to JSON schema: {...}"
 *
 * Bad descriptions are verbose or self-referential:
 *   "I am the permissions middleware and I enforce access control policies..."
 */
export interface CapabilityFragment {
  readonly label: string;
  readonly description: string;
}

/**
 * Middleware phase annotation for pipeline ordering.
 *
 * Middleware is sorted by phase tier first, then by priority within the tier:
 *   "intercept" (tier 0) — mutates or blocks requests (permissions, guardrails)
 *   "resolve"   (tier 1) — default; core business logic (dedup, retry, routing)
 *   "observe"   (tier 2) — read-only telemetry/audit (tracing, metrics)
 */
export type MiddlewarePhase = "intercept" | "resolve" | "observe";

export interface KoiMiddleware {
  readonly name: string;
  /** Middleware execution priority. Lower = outer onion layer (runs first). Default: 500. */
  readonly priority?: number;
  /** Pipeline phase for tier-based ordering. Default: "resolve". */
  readonly phase?: MiddlewarePhase;
  /**
   * When true AND phase is "observe", this middleware's `wrapModelCall` and `wrapToolCall`
   * hooks run concurrently with the next handler instead of sequentially in the onion.
   * Observer errors are silently swallowed — never propagated to the caller.
   * Only valid for observe-phase middleware. Ignored for intercept/resolve phases.
   *
   * Note: `wrapModelStream` always runs sequentially regardless of this flag —
   * concurrent stream observation is not supported because observers cannot
   * meaningfully inspect an independent copy of a streaming async iterable.
   */
  readonly concurrent?: boolean;
  /** Called once when an agent session begins. */
  readonly onSessionStart?: (ctx: SessionContext) => Promise<void>;
  /** Called once when an agent session ends. */
  readonly onSessionEnd?: (ctx: SessionContext) => Promise<void>;
  /** Called before each turn's model call. */
  readonly onBeforeTurn?: (ctx: TurnContext) => Promise<void>;
  /** Called after each turn completes. */
  readonly onAfterTurn?: (ctx: TurnContext) => Promise<void>;
  /** Onion wrapper for model calls. Call `next(req)` to continue the chain. */
  readonly wrapModelCall?: (
    ctx: TurnContext,
    request: ModelRequest,
    next: ModelHandler,
  ) => Promise<ModelResponse>;
  /** Onion wrapper for model streams. Call `next(req)` to continue the chain. */
  readonly wrapModelStream?: (
    ctx: TurnContext,
    request: ModelRequest,
    next: ModelStreamHandler,
  ) => AsyncIterable<ModelChunk>;
  /** Onion wrapper for tool calls. Call `next(req)` to continue the chain. */
  readonly wrapToolCall?: (
    ctx: TurnContext,
    request: ToolRequest,
    next: ToolHandler,
  ) => Promise<ToolResponse>;
  /** Self-description injected into model calls. Required. Return undefined to skip injection. */
  readonly describeCapabilities: (ctx: TurnContext) => CapabilityFragment | undefined;
}

/**
 * A convenience bundle combining a middleware with its associated ComponentProviders.
 *
 * Middleware and tool registration are separate concerns — this type packages them
 * together for cohesive features (e.g., compactor middleware + compact_context tool)
 * while letting the caller register each part through the appropriate channel.
 */
export interface MiddlewareBundle {
  readonly middleware: KoiMiddleware;
  readonly providers: readonly ComponentProvider[];
}
