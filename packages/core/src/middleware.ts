/**
 * Middleware contract — sole interposition layer for model/tool calls.
 */

import type { InboundMessage } from "./message.js";

export interface SessionContext {
  readonly agentId: string;
  readonly sessionId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface TurnContext {
  readonly session: SessionContext;
  readonly turnIndex: number;
  readonly messages: readonly InboundMessage[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
  readonly messages: readonly InboundMessage[];
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ModelResponse {
  readonly content: string;
  readonly model: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ModelHandler = (request: ModelRequest) => Promise<ModelResponse>;

export interface ToolRequest {
  readonly toolId: string;
  readonly input: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolResponse {
  readonly output: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ToolHandler = (request: ToolRequest) => Promise<ToolResponse>;

export interface KoiMiddleware {
  readonly name: string;
  readonly beforeModel?: (
    ctx: TurnContext,
    request: ModelRequest,
    next: ModelHandler,
  ) => Promise<ModelResponse>;
  readonly afterModel?: (ctx: TurnContext, response: ModelResponse) => Promise<ModelResponse>;
  readonly beforeTool?: (
    ctx: TurnContext,
    request: ToolRequest,
    next: ToolHandler,
  ) => Promise<ToolResponse>;
  readonly afterTool?: (ctx: TurnContext, response: ToolResponse) => Promise<ToolResponse>;
  readonly onTurnStart?: (ctx: TurnContext) => Promise<void>;
  readonly onTurnEnd?: (ctx: TurnContext) => Promise<void>;
}
