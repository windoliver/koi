/**
 * Middleware contract — sole interposition layer for model/tool calls.
 */

import type { JsonObject } from "./common.js";
import type { InboundMessage } from "./message.js";

export interface SessionContext {
  readonly agentId: string;
  readonly sessionId: string;
  readonly metadata: JsonObject;
}

export interface TurnContext {
  readonly session: SessionContext;
  readonly turnIndex: number;
  readonly messages: readonly InboundMessage[];
  readonly metadata: JsonObject;
}

export interface ModelRequest {
  readonly messages: readonly InboundMessage[];
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly metadata?: JsonObject;
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

export interface KoiMiddleware {
  readonly name: string;
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
  /** Onion wrapper for tool calls. Call `next(req)` to continue the chain. */
  readonly wrapToolCall?: (
    ctx: TurnContext,
    request: ToolRequest,
    next: ToolHandler,
  ) => Promise<ToolResponse>;
}
