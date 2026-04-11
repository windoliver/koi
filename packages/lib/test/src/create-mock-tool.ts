/**
 * Mock tool factory — produces a ToolDescriptor + handler pair, records
 * every invocation for assertion.
 */

import type { JsonObject, ToolDescriptor, ToolHandler, ToolRequest, ToolResponse } from "@koi/core";

export interface RecordedToolCall {
  readonly request: ToolRequest;
  readonly response: ToolResponse;
  readonly timestamp: number;
}

export interface MockToolConfig {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonObject;
  /** Static output for all calls. Ignored if `handler` is provided. */
  readonly output?: unknown;
  /** Dynamic handler. Called on every invocation. Takes precedence over `output`. */
  readonly handler?: (request: ToolRequest) => ToolResponse | Promise<ToolResponse>;
}

export interface MockToolResult {
  readonly descriptor: ToolDescriptor;
  readonly handle: ToolHandler;
  readonly calls: readonly RecordedToolCall[];
  readonly callCount: () => number;
  readonly reset: () => void;
}

export function createMockTool(config: MockToolConfig): MockToolResult {
  const recorded: RecordedToolCall[] = [];

  const descriptor: ToolDescriptor = {
    name: config.name,
    description: config.description ?? `Mock tool: ${config.name}`,
    inputSchema: config.inputSchema ?? { type: "object" },
  };

  const handle: ToolHandler = async (request: ToolRequest): Promise<ToolResponse> => {
    const response: ToolResponse = config.handler
      ? await config.handler(request)
      : { output: config.output ?? null };
    recorded.push({ request, response, timestamp: Date.now() });
    return response;
  };

  return {
    descriptor,
    handle,
    calls: recorded,
    callCount: (): number => recorded.length,
    reset: (): void => {
      recorded.length = 0;
    },
  };
}
