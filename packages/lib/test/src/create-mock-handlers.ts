/**
 * Lightweight spy handlers — model/stream/tool handlers that record every
 * call without the overhead of a full adapter.
 *
 * Useful for middleware tests where only one layer of the pipeline is
 * under test and the terminal can be a stub.
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
} from "@koi/core";

export interface SpyModelHandler {
  readonly handler: ModelHandler;
  readonly calls: readonly ModelRequest[];
}

export interface SpyModelStreamHandler {
  readonly handler: ModelStreamHandler;
  readonly calls: readonly ModelRequest[];
}

export interface SpyToolHandler {
  readonly handler: ToolHandler;
  readonly calls: readonly ToolRequest[];
}

const DEFAULT_MODEL_RESPONSE: ModelResponse = {
  content: "",
  model: "mock-model",
  stopReason: "stop",
};

const DEFAULT_TOOL_RESPONSE: ToolResponse = {
  output: null,
};

export function createSpyModelHandler(response?: Partial<ModelResponse>): SpyModelHandler {
  const calls: ModelRequest[] = [];
  const merged: ModelResponse = { ...DEFAULT_MODEL_RESPONSE, ...response };
  const handler: ModelHandler = async (request: ModelRequest): Promise<ModelResponse> => {
    calls.push(request);
    return merged;
  };
  return { handler, calls };
}

export function createSpyModelStreamHandler(chunks: readonly ModelChunk[]): SpyModelStreamHandler {
  const calls: ModelRequest[] = [];
  const handler: ModelStreamHandler = (request: ModelRequest): AsyncIterable<ModelChunk> => {
    calls.push(request);
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<ModelChunk> {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };
  };
  return { handler, calls };
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
