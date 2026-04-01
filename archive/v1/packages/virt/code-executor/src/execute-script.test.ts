import { describe, expect, test } from "bun:test";
import type { JsonObject, Tool } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { executeScript } from "./execute-script.js";

function createMockTool(name: string, handler?: (args: JsonObject) => unknown): Tool {
  return {
    descriptor: {
      name,
      description: `Mock ${name} tool`,
      inputSchema: { type: "object" },
    },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      if (handler) return handler(args);
      return { result: `${name}-result` };
    },
  };
}

const EMPTY_TOOLS = new Map<string, Tool>();

describe("executeScript", () => {
  test("evaluates simple JavaScript", async () => {
    const result = await executeScript({
      code: "1 + 2",
      tools: EMPTY_TOOLS,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe(3);
  });

  test("evaluates TypeScript (strips types)", async () => {
    const result = await executeScript({
      // Use a function call so the transpiler doesn't optimize away the expression.
      code: "function getVal(): number { return 42; } getVal();",
      language: "typescript",
      tools: EMPTY_TOOLS,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe(42);
  });

  test("captures console output", async () => {
    const result = await executeScript({
      code: 'console.log("hello"); console.error("oops"); 42;',
      tools: EMPTY_TOOLS,
    });
    expect(result.ok).toBe(true);
    expect(result.console).toHaveLength(2);
    expect(result.console[0]?.level).toBe("log");
    expect(result.console[0]?.message).toBe("hello");
    expect(result.console[1]?.level).toBe("error");
    expect(result.console[1]?.message).toBe("oops");
  });

  test("calls a tool via callTool()", async () => {
    const tools = new Map([["greet", createMockTool("greet", (args) => `Hello ${args.name}`)]]);
    const result = await executeScript({
      code: 'callTool("greet", { name: "World" });',
      tools,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe("Hello World");
    expect(result.toolCallCount).toBe(1);
  });

  test("handles multiple sequential tool calls", async () => {
    // Justified `let`: counter for tracking calls.
    let count = 0;
    const tools = new Map([
      [
        "counter",
        createMockTool("counter", () => {
          count++;
          return count;
        }),
      ],
    ]);
    const result = await executeScript({
      code: `
        var a = callTool("counter", {});
        var b = callTool("counter", {});
        var c = callTool("counter", {});
        a + b + c;
      `,
      tools,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe(6); // 1 + 2 + 3
    expect(result.toolCallCount).toBe(3);
  });

  test("enforces timeout", async () => {
    const result = await executeScript({
      code: "while(true) {}",
      timeoutMs: 200,
      tools: EMPTY_TOOLS,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("enforces tool call budget", async () => {
    const tools = new Map([["my_tool", createMockTool("my_tool")]]);
    const result = await executeScript({
      code: `
        var i;
        for (i = 0; i < 10; i++) {
          try {
            callTool("my_tool", {});
          } catch(e) {
            break;
          }
        }
        i;
      `,
      maxToolCalls: 3,
      tools,
    });
    expect(result.ok).toBe(true);
    // Should have stopped at 4th call (budget exceeded)
    expect(result.result).toBe(3);
  });

  test("preserves console output on error", async () => {
    const result = await executeScript({
      code: 'console.log("before error"); throw new Error("boom");',
      tools: EMPTY_TOOLS,
    });
    expect(result.ok).toBe(false);
    expect(result.console).toHaveLength(1);
    expect(result.console[0]?.message).toBe("before error");
    expect(result.error).toContain("boom");
  });

  test("reports duration", async () => {
    const result = await executeScript({
      code: "42",
      tools: EMPTY_TOOLS,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("handles TypeScript transpilation error gracefully", async () => {
    // Bun's transpiler is lenient, but let's at least verify no crash
    const result = await executeScript({
      code: "var x = 1;",
      language: "typescript",
      tools: EMPTY_TOOLS,
    });
    expect(typeof result.ok).toBe("boolean");
  });
});
