/**
 * Integration tests for tool recovery middleware — end-to-end with mock handler.
 */

import { describe, expect, test } from "bun:test";
import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core/middleware";
import { createMockTurnContext } from "@koi/test-utils";
import { createToolRecoveryMiddleware } from "../recovery-middleware.js";

const TOOLS = [
  { name: "get_weather", description: "Get weather", inputSchema: {} },
  { name: "search", description: "Search", inputSchema: {} },
  { name: "get_time", description: "Get time", inputSchema: {} },
] as const;

function createRequest(tools?: ModelRequest["tools"]): ModelRequest {
  const base = { messages: [] as const };
  if (tools !== undefined) return { ...base, tools };
  return base;
}

function createResponse(content: string, metadata?: ModelResponse["metadata"]): ModelResponse {
  const base = { content, model: "test-model" };
  if (metadata !== undefined) return { ...base, metadata };
  return base;
}

/** Call wrapModelCall — asserts it is defined (always true for this middleware). */
function callWrap(
  mw: KoiMiddleware,
  ctx: TurnContext,
  request: ModelRequest,
  handler: ModelHandler,
): Promise<ModelResponse> {
  const wrap = mw.wrapModelCall;
  if (wrap === undefined) throw new Error("wrapModelCall is undefined");
  return wrap(ctx, request, handler);
}

describe("middleware integration", () => {
  test("extracts Hermes-format tool call from model response", async () => {
    const mw = createToolRecoveryMiddleware();
    const handler: ModelHandler = async () =>
      createResponse(
        'I will check the weather.\n<tool_call>{"name": "get_weather", "arguments": {"city": "Tokyo"}}</tool_call>',
      );
    const ctx = createMockTurnContext();
    const result = await callWrap(mw, ctx, createRequest(TOOLS), handler);

    expect(result.content).toBe("I will check the weather.");
    const toolCalls = result.metadata?.toolCalls as readonly {
      readonly toolName: string;
      readonly callId: string;
      readonly input: Record<string, unknown>;
    }[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("get_weather");
    expect(toolCalls[0]?.input).toEqual({ city: "Tokyo" });
    expect(toolCalls[0]?.callId).toMatch(/^recovery-/);
  });

  test("extracts Llama 3.1 format tool call", async () => {
    const mw = createToolRecoveryMiddleware({ patterns: ["llama31"] });
    const handler: ModelHandler = async () =>
      createResponse('<function=search>{"q": "koi fish"}</function>');
    const ctx = createMockTurnContext();
    const result = await callWrap(mw, ctx, createRequest(TOOLS), handler);

    const toolCalls = result.metadata?.toolCalls as readonly {
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    }[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("search");
    expect(toolCalls[0]?.input).toEqual({ q: "koi fish" });
  });

  test("extracts JSON fence format tool call", async () => {
    const mw = createToolRecoveryMiddleware({ patterns: ["json-fence"] });
    const handler: ModelHandler = async () =>
      createResponse('```json\n{"name": "get_time", "arguments": {"tz": "UTC"}}\n```');
    const ctx = createMockTurnContext();
    const result = await callWrap(mw, ctx, createRequest(TOOLS), handler);

    const toolCalls = result.metadata?.toolCalls as readonly {
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    }[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("get_time");
  });

  test("passes through native tool calls untouched", async () => {
    const mw = createToolRecoveryMiddleware();
    const existingCalls = [{ toolName: "search", callId: "native-1", input: { q: "test" } }];
    const handler: ModelHandler = async () => createResponse("", { toolCalls: existingCalls });
    const ctx = createMockTurnContext();
    const result = await callWrap(mw, ctx, createRequest(TOOLS), handler);

    expect(result.metadata?.toolCalls).toBe(existingCalls);
  });

  test("treats unknown tool name as plain text", async () => {
    const mw = createToolRecoveryMiddleware({ patterns: ["hermes"] });
    const handler: ModelHandler = async () =>
      createResponse('<tool_call>{"name": "nonexistent_tool", "arguments": {}}</tool_call>');
    const ctx = createMockTurnContext();
    const result = await callWrap(mw, ctx, createRequest(TOOLS), handler);

    // Tool name not in allowed set → no recovery
    expect(result.metadata?.toolCalls).toBeUndefined();
    expect(result.content).toContain("nonexistent_tool");
  });

  test("preserves surrounding text when extracting tool calls", async () => {
    const mw = createToolRecoveryMiddleware({ patterns: ["hermes"] });
    const handler: ModelHandler = async () =>
      createResponse(
        'Thinking about it...\n<tool_call>{"name": "search", "arguments": {"q": "test"}}</tool_call>\nHere are the results.',
      );
    const ctx = createMockTurnContext();
    const result = await callWrap(mw, ctx, createRequest(TOOLS), handler);

    expect(result.content).toBe("Thinking about it...\n\nHere are the results.");
    const toolCalls = result.metadata?.toolCalls as readonly unknown[];
    expect(toolCalls).toHaveLength(1);
  });

  test("passes through empty response", async () => {
    const mw = createToolRecoveryMiddleware();
    const handler: ModelHandler = async () => createResponse("");
    const ctx = createMockTurnContext();
    const result = await callWrap(mw, ctx, createRequest(TOOLS), handler);

    expect(result.content).toBe("");
    expect(result.metadata?.toolCalls).toBeUndefined();
  });

  test("first pattern wins when multiple configured", async () => {
    // Both hermes and json-fence could match different parts
    const mw = createToolRecoveryMiddleware({ patterns: ["hermes", "json-fence"] });
    const handler: ModelHandler = async () =>
      createResponse('<tool_call>{"name": "search", "arguments": {"q": "test"}}</tool_call>');
    const ctx = createMockTurnContext();
    const result = await callWrap(mw, ctx, createRequest(TOOLS), handler);

    const toolCalls = result.metadata?.toolCalls as readonly {
      readonly toolName: string;
    }[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("search");
  });

  test("handles multiple tool calls in single response", async () => {
    const mw = createToolRecoveryMiddleware({ patterns: ["hermes"] });
    const handler: ModelHandler = async () =>
      createResponse(
        [
          '<tool_call>{"name": "get_weather", "arguments": {"city": "London"}}</tool_call>',
          '<tool_call>{"name": "get_time", "arguments": {"tz": "GMT"}}</tool_call>',
        ].join("\n"),
      );
    const ctx = createMockTurnContext();
    const result = await callWrap(mw, ctx, createRequest(TOOLS), handler);

    const toolCalls = result.metadata?.toolCalls as readonly {
      readonly toolName: string;
      readonly callId: string;
    }[];
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.callId).toMatch(/-0$/);
    expect(toolCalls[1]?.callId).toMatch(/-1$/);
  });

  test("passes through when no tools in request", async () => {
    const mw = createToolRecoveryMiddleware();
    const handler: ModelHandler = async () =>
      createResponse('<tool_call>{"name": "search", "arguments": {}}</tool_call>');
    const ctx = createMockTurnContext();
    const result = await callWrap(mw, ctx, createRequest(), handler);

    // No tools -> short-circuit, text preserved as-is
    expect(result.content).toContain("tool_call");
    expect(result.metadata?.toolCalls).toBeUndefined();
  });

  test("works with custom pattern", async () => {
    const customPattern = {
      name: "custom",
      detect(text: string) {
        const match = /CALL:(\w+)\((\{.*?\})\)/.exec(text);
        if (match === null) return undefined;
        const parsed = JSON.parse(match[2] ?? "{}") as Record<string, unknown>;
        const remaining = text.replace(match[0], "").trim();
        return {
          toolCalls: [{ toolName: match[1] ?? "", arguments: parsed }],
          remainingText: remaining,
        };
      },
    };
    const mw = createToolRecoveryMiddleware({ patterns: [customPattern] });
    const handler: ModelHandler = async () => createResponse('CALL:search({"q":"test"})');
    const ctx = createMockTurnContext();
    const result = await callWrap(mw, ctx, createRequest(TOOLS), handler);

    const toolCalls = result.metadata?.toolCalls as readonly {
      readonly toolName: string;
    }[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("search");
  });
});
