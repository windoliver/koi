import { describe, expect, test } from "bun:test";
import type { JsonObject, Tool } from "@koi/core";
import { createExecuteScriptTool } from "./execute-script-tool.js";

const EMPTY_TOOLS = new Map<string, Tool>();

function createMockTool(name: string, handler?: (args: JsonObject) => unknown): Tool {
  return {
    descriptor: {
      name,
      description: `Mock ${name} tool`,
      inputSchema: { type: "object" },
    },
    trustTier: "verified",
    execute: async (args: JsonObject): Promise<unknown> => {
      if (handler) return handler(args);
      return { result: `${name}-result` };
    },
  };
}

describe("createExecuteScriptTool", () => {
  test("has correct descriptor", () => {
    const tool = createExecuteScriptTool(EMPTY_TOOLS);
    expect(tool.descriptor.name).toBe("execute_script");
    expect(tool.trustTier).toBe("sandbox");
  });

  test("description explains callTool API", () => {
    const tool = createExecuteScriptTool(EMPTY_TOOLS);
    expect(tool.descriptor.description).toContain("callTool");
    expect(tool.descriptor.description).toContain("multiple tool calls");
  });

  test("returns error when code is missing", async () => {
    const tool = createExecuteScriptTool(EMPTY_TOOLS);
    const result = (await tool.execute({})) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("code is required");
  });

  test("returns error for unsupported language", async () => {
    const tool = createExecuteScriptTool(EMPTY_TOOLS);
    const result = (await tool.execute({ code: "1+1", language: "python" })) as Record<
      string,
      unknown
    >;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unsupported language");
  });

  test("executes JavaScript code", async () => {
    const tool = createExecuteScriptTool(EMPTY_TOOLS);
    const result = (await tool.execute({ code: "1 + 2" })) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.result).toBe(3);
  });

  test("returns script throw as error with ok=false", async () => {
    const tool = createExecuteScriptTool(EMPTY_TOOLS);
    const result = (await tool.execute({
      code: 'throw new Error("something went wrong");',
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("something went wrong");
  });

  test("returns tool call error back to agent", async () => {
    const failingTool = createMockTool("broken_tool", () => {
      throw new Error("upstream service unavailable");
    });
    const tools = new Map([["broken_tool", failingTool]]);
    const tool = createExecuteScriptTool(tools);

    // Script doesn't catch the error, so it propagates as a script crash.
    const result = (await tool.execute({
      code: 'callTool("broken_tool", {});',
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("upstream service unavailable");
  });

  test("returns unknown tool error back to agent", async () => {
    const tool = createExecuteScriptTool(EMPTY_TOOLS);
    const result = (await tool.execute({
      code: 'callTool("nonexistent_tool", {});',
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  test("preserves console output even on error", async () => {
    const tool = createExecuteScriptTool(EMPTY_TOOLS);
    const result = (await tool.execute({
      code: 'console.log("debug info"); throw new Error("boom");',
    })) as { ok: boolean; error: string; console: Array<{ message: string }> };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
    expect(result.console).toHaveLength(1);
    expect(result.console[0]?.message).toBe("debug info");
  });

  test("clamps timeout to bounds", async () => {
    const tool = createExecuteScriptTool(EMPTY_TOOLS);
    // Very small timeout should still work for simple code
    const result = (await tool.execute({ code: "42", timeout_ms: 50 })) as Record<string, unknown>;

    // Should use clamped minimum of 100ms, which is fine for "42"
    expect(result.ok).toBe(true);
    expect(result.result).toBe(42);
  });

  test("inputSchema requires code field", () => {
    const tool = createExecuteScriptTool(EMPTY_TOOLS);
    const schema = tool.descriptor.inputSchema as Record<string, unknown>;

    expect(schema.required).toEqual(["code"]);
  });
});
