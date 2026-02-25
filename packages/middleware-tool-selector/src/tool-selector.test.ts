import { describe, expect, test } from "bun:test";
import type { ModelRequest, ModelResponse, ToolDescriptor } from "@koi/core";
import { createMockInboundMessage, createMockTurnContext } from "@koi/test-utils";
import { createToolSelectorMiddleware } from "./tool-selector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTools(count: number): readonly ToolDescriptor[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool-${i}`,
    description: `Tool ${i}`,
    inputSchema: {},
  }));
}

function mockModelResponse(): ModelResponse {
  return { content: "ok", model: "test-model" };
}

function makeRequest(tools: readonly ToolDescriptor[], text = "hello"): ModelRequest {
  return {
    messages: [createMockInboundMessage({ text })],
    tools,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createToolSelectorMiddleware", () => {
  test("has name 'tool-selector'", () => {
    const mw = createToolSelectorMiddleware({
      selectTools: async () => [],
    });
    expect(mw.name).toBe("tool-selector");
  });

  test("has priority 420", () => {
    const mw = createToolSelectorMiddleware({
      selectTools: async () => [],
    });
    expect(mw.priority).toBe(420);
  });

  test("passes through when tools count <= minTools", async () => {
    const tools = makeTools(3);
    let receivedRequest: ModelRequest | undefined;

    const mw = createToolSelectorMiddleware({
      selectTools: async () => {
        throw new Error("should not be called");
      },
      minTools: 5,
    });

    const ctx = createMockTurnContext();
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    await mw.wrapModelCall?.(ctx, makeRequest(tools), next);

    expect(receivedRequest).toBeDefined();
    expect(receivedRequest?.tools).toHaveLength(3);
  });

  test("passes through when tools is undefined", async () => {
    let receivedRequest: ModelRequest | undefined;

    const mw = createToolSelectorMiddleware({
      selectTools: async () => {
        throw new Error("should not be called");
      },
    });

    const ctx = createMockTurnContext();
    const request: ModelRequest = {
      messages: [createMockInboundMessage({ text: "hello" })],
    };
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    await mw.wrapModelCall?.(ctx, request, next);

    expect(receivedRequest).toBeDefined();
    expect(receivedRequest?.tools).toBeUndefined();
  });

  test("calls selectTools and filters tools", async () => {
    const tools = makeTools(10);
    let receivedRequest: ModelRequest | undefined;

    const mw = createToolSelectorMiddleware({
      selectTools: async (_query, _tools) => ["tool-1", "tool-3", "tool-5"],
      minTools: 5,
    });

    const ctx = createMockTurnContext();
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    await mw.wrapModelCall?.(ctx, makeRequest(tools), next);

    expect(receivedRequest).toBeDefined();
    expect(receivedRequest?.tools).toHaveLength(3);
    expect(receivedRequest?.tools?.map((t) => t.name)).toEqual(["tool-1", "tool-3", "tool-5"]);
  });

  test("includes alwaysInclude tools even if not selected", async () => {
    const tools = makeTools(10);
    let receivedRequest: ModelRequest | undefined;

    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["tool-1"],
      alwaysInclude: ["tool-9"],
      minTools: 5,
    });

    const ctx = createMockTurnContext();
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    await mw.wrapModelCall?.(ctx, makeRequest(tools), next);

    expect(receivedRequest).toBeDefined();
    const names = receivedRequest?.tools?.map((t) => t.name);
    expect(names).toContain("tool-1");
    expect(names).toContain("tool-9");
  });

  test("caps selected tools at maxTools", async () => {
    const tools = makeTools(20);
    let receivedRequest: ModelRequest | undefined;

    const mw = createToolSelectorMiddleware({
      selectTools: async () => Array.from({ length: 20 }, (_, i) => `tool-${i}`),
      maxTools: 3,
      minTools: 5,
    });

    const ctx = createMockTurnContext();
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    await mw.wrapModelCall?.(ctx, makeRequest(tools), next);

    expect(receivedRequest).toBeDefined();
    // maxTools = 3, no alwaysInclude
    expect(receivedRequest?.tools).toHaveLength(3);
  });

  test("alwaysInclude can exceed maxTools cap", async () => {
    const tools = makeTools(20);
    let receivedRequest: ModelRequest | undefined;

    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["tool-0", "tool-1"],
      maxTools: 2,
      alwaysInclude: ["tool-19"],
      minTools: 5,
    });

    const ctx = createMockTurnContext();
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    await mw.wrapModelCall?.(ctx, makeRequest(tools), next);

    expect(receivedRequest).toBeDefined();
    // 2 selected + 1 alwaysInclude = 3
    expect(receivedRequest?.tools).toHaveLength(3);
  });

  test("gracefully degrades when selectTools throws", async () => {
    const tools = makeTools(10);
    let receivedRequest: ModelRequest | undefined;

    const mw = createToolSelectorMiddleware({
      selectTools: async () => {
        throw new Error("selector crashed");
      },
      minTools: 5,
    });

    const ctx = createMockTurnContext();
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    // Should not throw — graceful degradation
    await mw.wrapModelCall?.(ctx, makeRequest(tools), next);

    expect(receivedRequest).toBeDefined();
    // All tools passed through (no filtering)
    expect(receivedRequest?.tools).toHaveLength(10);
  });

  test("filters out invalid tool names from selectTools", async () => {
    const tools = makeTools(10);
    let receivedRequest: ModelRequest | undefined;

    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["tool-1", "nonexistent-tool", "tool-3"],
      minTools: 5,
    });

    const ctx = createMockTurnContext();
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    await mw.wrapModelCall?.(ctx, makeRequest(tools), next);

    expect(receivedRequest).toBeDefined();
    // "nonexistent-tool" is in the nameSet but not in tools, so filter skips it
    expect(receivedRequest?.tools).toHaveLength(2);
    expect(receivedRequest?.tools?.map((t) => t.name)).toEqual(["tool-1", "tool-3"]);
  });

  test("ignores alwaysInclude names not in tool list", async () => {
    const tools = makeTools(10);
    let receivedRequest: ModelRequest | undefined;

    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["tool-1"],
      alwaysInclude: ["nonexistent-tool"],
      minTools: 5,
    });

    const ctx = createMockTurnContext();
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    await mw.wrapModelCall?.(ctx, makeRequest(tools), next);

    expect(receivedRequest).toBeDefined();
    // Only tool-1 matches; nonexistent is ignored during filter
    expect(receivedRequest?.tools).toHaveLength(1);
    expect(receivedRequest?.tools?.[0]?.name).toBe("tool-1");
  });

  test("passes through when extractQuery returns empty string", async () => {
    const tools = makeTools(10);
    let receivedRequest: ModelRequest | undefined;

    const mw = createToolSelectorMiddleware({
      selectTools: async () => {
        throw new Error("should not be called");
      },
      minTools: 5,
    });

    const ctx = createMockTurnContext();
    const request: ModelRequest = {
      messages: [],
      tools,
    };
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    await mw.wrapModelCall?.(ctx, request, next);

    expect(receivedRequest).toBeDefined();
    expect(receivedRequest?.tools).toHaveLength(10);
  });

  test("records toolsBeforeFilter and toolsAfterFilter in metadata", async () => {
    const tools = makeTools(10);
    let receivedRequest: ModelRequest | undefined;

    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["tool-1", "tool-2"],
      minTools: 5,
    });

    const ctx = createMockTurnContext();
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    await mw.wrapModelCall?.(ctx, makeRequest(tools), next);

    expect(receivedRequest).toBeDefined();
    expect(receivedRequest?.metadata).toBeDefined();
    expect(receivedRequest?.metadata?.toolsBeforeFilter).toBe(10);
    expect(receivedRequest?.metadata?.toolsAfterFilter).toBe(2);
  });

  test("uses custom extractQuery when provided", async () => {
    const tools = makeTools(10);
    let queryReceived: string | undefined;

    const mw = createToolSelectorMiddleware({
      selectTools: async (query) => {
        queryReceived = query;
        return ["tool-0"];
      },
      extractQuery: () => "custom-query",
      minTools: 5,
    });

    const ctx = createMockTurnContext();
    const next = async (_req: ModelRequest): Promise<ModelResponse> => {
      return mockModelResponse();
    };

    await mw.wrapModelCall?.(ctx, makeRequest(tools), next);

    expect(queryReceived).toBe("custom-query");
  });

  test("throws on invalid config", () => {
    expect(() => {
      createToolSelectorMiddleware({} as never);
    }).toThrow();
  });

  test("implements wrapModelStream", () => {
    const mw = createToolSelectorMiddleware({
      selectTools: async () => [],
    });
    expect(mw.wrapModelStream).toBeDefined();
  });

  test("wrapModelStream filters tools the same as wrapModelCall", async () => {
    const tools = makeTools(10);
    let streamReceivedRequest: ModelRequest | undefined;

    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["tool-1", "tool-3"],
      minTools: 5,
    });

    const ctx = createMockTurnContext();
    const chunks = [{ kind: "text_delta" as const, delta: "hi" }];
    const next = (req: ModelRequest) => {
      streamReceivedRequest = req;
      return (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })();
    };

    const result = mw.wrapModelStream?.(ctx, makeRequest(tools), next);
    // Consume the async iterable
    if (result !== undefined) {
      for await (const _chunk of result) {
        // drain
      }
    }

    expect(streamReceivedRequest).toBeDefined();
    expect(streamReceivedRequest?.tools).toHaveLength(2);
    expect(streamReceivedRequest?.tools?.map((t) => t.name)).toEqual(["tool-1", "tool-3"]);
  });
});
