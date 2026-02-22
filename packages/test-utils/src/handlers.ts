/**
 * Mock and spy handler factories for middleware testing.
 */

import type {
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ToolHandler,
  ToolRequest,
  ToolResponse,
} from "@koi/core/middleware";

const DEFAULT_MODEL_RESPONSE: ModelResponse = {
  content: "mock response",
  model: "test-model",
  usage: { inputTokens: 10, outputTokens: 20 },
};

const DEFAULT_TOOL_RESPONSE: ToolResponse = {
  output: { result: "mock" },
};

export function createMockModelHandler(response?: Partial<ModelResponse>): ModelHandler {
  const merged: ModelResponse = { ...DEFAULT_MODEL_RESPONSE, ...response };
  return async (_request: ModelRequest): Promise<ModelResponse> => merged;
}

export function createMockToolHandler(response?: Partial<ToolResponse>): ToolHandler {
  const merged: ToolResponse = { ...DEFAULT_TOOL_RESPONSE, ...response };
  return async (_request: ToolRequest): Promise<ToolResponse> => merged;
}

export interface SpyModelHandler {
  readonly handler: ModelHandler;
  readonly calls: readonly ModelRequest[];
}

export function createSpyModelHandler(response?: Partial<ModelResponse>): SpyModelHandler {
  const calls: ModelRequest[] = [];
  const merged: ModelResponse = { ...DEFAULT_MODEL_RESPONSE, ...response };
  const handler: ModelHandler = async (request: ModelRequest): Promise<ModelResponse> => {
    calls.push(request);
    return merged;
  };
  return { handler, calls };
}

export interface SpyToolHandler {
  readonly handler: ToolHandler;
  readonly calls: readonly ToolRequest[];
}

export function createSpyToolHandler(response?: Partial<ToolResponse>): SpyToolHandler {
  const calls: ToolRequest[] = [];
  const merged: ToolResponse = { ...DEFAULT_TOOL_RESPONSE, ...response };
  const handler: ToolHandler = async (request: ToolRequest): Promise<ToolResponse> => {
    calls.push(request);
    return merged;
  };
  return { handler, calls };
}
