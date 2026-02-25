/**
 * Mock and spy handler factories for middleware testing.
 */

import type {
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
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

// ---------------------------------------------------------------------------
// Model stream handlers
// ---------------------------------------------------------------------------

export interface SpyModelStreamHandler {
  readonly handler: ModelStreamHandler;
  readonly calls: readonly ModelRequest[];
}

/**
 * Creates a spy model stream handler that yields provided chunks and records calls.
 */
export function createSpyModelStreamHandler(chunks: readonly ModelChunk[]): SpyModelStreamHandler {
  const calls: ModelRequest[] = [];
  const handler: ModelStreamHandler = (request: ModelRequest): AsyncIterable<ModelChunk> => {
    calls.push(request);
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };
  };
  return { handler, calls };
}

/**
 * Creates a mock model stream handler that yields provided chunks.
 */
export function createMockModelStreamHandler(chunks: readonly ModelChunk[]): ModelStreamHandler {
  return (_request: ModelRequest): AsyncIterable<ModelChunk> => ({
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  });
}
