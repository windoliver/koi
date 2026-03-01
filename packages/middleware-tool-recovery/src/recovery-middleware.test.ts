import { describe, expect, test } from "bun:test";
import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core/middleware";
import { createMockTurnContext } from "@koi/test-utils";
import { createToolRecoveryMiddleware } from "./recovery-middleware.js";
import type { RecoveryEvent } from "./types.js";

function createModelResponse(content: string, metadata?: ModelResponse["metadata"]): ModelResponse {
  const base = { content, model: "test-model" };
  if (metadata !== undefined) return { ...base, metadata };
  return base;
}

function createHandler(response: ModelResponse): ModelHandler {
  return async (_req: ModelRequest) => response;
}

/** Call wrapModelCall — asserts it is defined (always true for this middleware). */
function callWrapModelCall(
  mw: KoiMiddleware,
  ctx: TurnContext,
  request: ModelRequest,
  handler: ModelHandler,
): Promise<ModelResponse> {
  const wrap = mw.wrapModelCall;
  if (wrap === undefined) throw new Error("wrapModelCall is undefined");
  return wrap(ctx, request, handler);
}

const TOOLS = [
  { name: "get_weather", description: "Get weather", inputSchema: {} },
  { name: "search", description: "Search", inputSchema: {} },
] as const;

const REQUEST_WITH_TOOLS: ModelRequest = {
  messages: [],
  tools: TOOLS,
};

const REQUEST_WITHOUT_TOOLS: ModelRequest = {
  messages: [],
};

describe("createToolRecoveryMiddleware", () => {
  test("creates middleware with correct name and priority", () => {
    const mw = createToolRecoveryMiddleware();
    expect(mw.name).toBe("tool-recovery");
    expect(mw.priority).toBe(180);
  });

  test("describeCapabilities returns pattern names", () => {
    const mw = createToolRecoveryMiddleware({ patterns: ["hermes"] });
    const ctx = createMockTurnContext();
    const cap = mw.describeCapabilities(ctx);
    expect(cap).toBeDefined();
    expect(cap?.label).toBe("tool-recovery");
    expect(cap?.description).toContain("hermes");
  });

  test("short-circuits when no tools in request", async () => {
    const mw = createToolRecoveryMiddleware();
    const response = createModelResponse("plain text");
    const handler = createHandler(response);
    const ctx = createMockTurnContext();
    const result = await callWrapModelCall(mw, ctx, REQUEST_WITHOUT_TOOLS, handler);
    expect(result.content).toBe("plain text");
    expect(result.metadata?.toolCalls).toBeUndefined();
  });

  test("short-circuits when response already has toolCalls", async () => {
    const mw = createToolRecoveryMiddleware();
    const existingToolCalls = [{ toolName: "x", callId: "existing-1", input: {} }];
    const response = createModelResponse("text", { toolCalls: existingToolCalls });
    const handler = createHandler(response);
    const ctx = createMockTurnContext();
    const result = await callWrapModelCall(mw, ctx, REQUEST_WITH_TOOLS, handler);
    expect(result.metadata?.toolCalls).toBe(existingToolCalls);
  });

  test("recovers Hermes-format tool call", async () => {
    const mw = createToolRecoveryMiddleware({ patterns: ["hermes"] });
    const response = createModelResponse(
      '<tool_call>{"name": "get_weather", "arguments": {"city": "London"}}</tool_call>',
    );
    const handler = createHandler(response);
    const ctx = createMockTurnContext();
    const result = await callWrapModelCall(mw, ctx, REQUEST_WITH_TOOLS, handler);
    expect(result.content).toBe("");
    const toolCalls = result.metadata?.toolCalls as readonly {
      readonly toolName: string;
      readonly callId: string;
      readonly input: Record<string, unknown>;
    }[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("get_weather");
    expect(toolCalls[0]?.input).toEqual({ city: "London" });
  });

  test("generates deterministic callId from turnId", async () => {
    const mw = createToolRecoveryMiddleware({ patterns: ["hermes"] });
    const response = createModelResponse(
      '<tool_call>{"name": "search", "arguments": {"q": "koi"}}</tool_call>',
    );
    const handler = createHandler(response);
    const ctx = createMockTurnContext();
    const result = await callWrapModelCall(mw, ctx, REQUEST_WITH_TOOLS, handler);
    const toolCalls = result.metadata?.toolCalls as readonly { readonly callId: string }[];
    expect(toolCalls[0]?.callId).toBe(`recovery-${ctx.turnId}-0`);
  });

  test("passes through unmatched text", async () => {
    const mw = createToolRecoveryMiddleware({ patterns: ["hermes"] });
    const response = createModelResponse("no tool calls here");
    const handler = createHandler(response);
    const ctx = createMockTurnContext();
    const result = await callWrapModelCall(mw, ctx, REQUEST_WITH_TOOLS, handler);
    expect(result.content).toBe("no tool calls here");
    expect(result.metadata?.toolCalls).toBeUndefined();
  });

  test("caps recovered tool calls at maxToolCallsPerResponse", async () => {
    const mw = createToolRecoveryMiddleware({
      patterns: ["hermes"],
      maxToolCallsPerResponse: 1,
    });
    const response = createModelResponse(
      [
        '<tool_call>{"name": "search", "arguments": {"q": "a"}}</tool_call>',
        '<tool_call>{"name": "get_weather", "arguments": {"city": "B"}}</tool_call>',
      ].join("\n"),
    );
    const handler = createHandler(response);
    const ctx = createMockTurnContext();
    const result = await callWrapModelCall(mw, ctx, REQUEST_WITH_TOOLS, handler);
    const toolCalls = result.metadata?.toolCalls as readonly unknown[];
    expect(toolCalls).toHaveLength(1);
  });

  test("emits recovery events via onRecoveryEvent", async () => {
    const events: RecoveryEvent[] = [];
    const mw = createToolRecoveryMiddleware({
      patterns: ["hermes"],
      onRecoveryEvent: (e) => events.push(e),
    });
    const response = createModelResponse(
      '<tool_call>{"name": "search", "arguments": {"q": "koi"}}</tool_call>',
    );
    const handler = createHandler(response);
    const ctx = createMockTurnContext();
    await callWrapModelCall(mw, ctx, REQUEST_WITH_TOOLS, handler);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("recovered");
  });

  test("rejects tool calls not in request.tools", async () => {
    const events: RecoveryEvent[] = [];
    const mw = createToolRecoveryMiddleware({
      patterns: ["hermes"],
      onRecoveryEvent: (e) => events.push(e),
    });
    const response = createModelResponse(
      '<tool_call>{"name": "unknown_tool", "arguments": {}}</tool_call>',
    );
    const handler = createHandler(response);
    const ctx = createMockTurnContext();
    const result = await callWrapModelCall(mw, ctx, REQUEST_WITH_TOOLS, handler);
    // All calls rejected → no modification
    expect(result.metadata?.toolCalls).toBeUndefined();
    expect(events.some((e) => e.kind === "rejected")).toBe(true);
  });
});
