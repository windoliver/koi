/**
 * Middleware contract — sole interposition layer for model/tool calls.
 */

import type { ChannelStatus } from "./channel.js";
import type { JsonObject } from "./common.js";
import type { RunId, SessionId, ToolCallId, TurnId } from "./ecs.js";
import type { InboundMessage } from "./message.js";

export interface SessionContext {
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly runId: RunId;
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
}

export interface ModelResponse {
  readonly content: string;
  readonly model: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly metadata?: JsonObject;
}

export type ModelHandler = (request: ModelRequest) => Promise<ModelResponse>;

export type ModelChunk =
  | { readonly kind: "text_delta"; readonly delta: string }
  | { readonly kind: "thinking_delta"; readonly delta: string }
  | { readonly kind: "tool_call_start"; readonly toolName: string; readonly callId: ToolCallId }
  | { readonly kind: "tool_call_delta"; readonly callId: ToolCallId; readonly delta: string }
  | { readonly kind: "tool_call_end"; readonly callId: ToolCallId }
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: "done"; readonly response: ModelResponse };

export type ModelStreamHandler = (request: ModelRequest) => AsyncIterable<ModelChunk>;

export interface ToolRequest {
  readonly toolId: string;
  readonly input: JsonObject;
  readonly metadata?: JsonObject;
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

export interface KoiMiddleware {
  readonly name: string;
  /** Middleware execution priority. Lower = outer onion layer (runs first). Default: 500. */
  readonly priority?: number;
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
}
