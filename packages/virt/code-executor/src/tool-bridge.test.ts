import { describe, expect, test } from "bun:test";
import type { JsonObject, Tool } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createToolBridge } from "./tool-bridge.js";

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

describe("createToolBridge", () => {
  test("routes callTool to the correct tool", async () => {
    const tools = new Map([["my_tool", createMockTool("my_tool")]]);
    const bridge = createToolBridge({ tools });
    const callToolRaw = bridge.hostFunctions.get("__callToolRaw") as
      | ((s: string) => Promise<string>)
      | undefined;
    expect(callToolRaw).toBeDefined();

    const result = await callToolRaw?.(JSON.stringify({ name: "my_tool", args: {} }));
    const parsed = JSON.parse(result ?? "{}") as Record<string, unknown>;

    // Envelope protocol: { __koi_ok: true, value: ... }
    expect(parsed.__koi_ok).toBe(true);
    const value = parsed.value as Record<string, unknown>;
    expect(value.result).toBe("my_tool-result");
  });

  test("returns error for unknown tool", async () => {
    const tools = new Map<string, Tool>();
    const bridge = createToolBridge({ tools });
    const callToolRaw = bridge.hostFunctions.get("__callToolRaw") as
      | ((s: string) => Promise<string>)
      | undefined;
    expect(callToolRaw).toBeDefined();

    const result = await callToolRaw?.(JSON.stringify({ name: "nonexistent" }));
    const parsed = JSON.parse(result ?? "{}") as Record<string, unknown>;

    expect(parsed.__koi_ok).toBe(false);
    expect(parsed.__koi_error).toContain("Unknown tool");
  });

  test("enforces call budget", async () => {
    const tools = new Map([["my_tool", createMockTool("my_tool")]]);
    const bridge = createToolBridge({ tools, maxCalls: 2 });
    const callToolRaw = bridge.hostFunctions.get("__callToolRaw") as
      | ((s: string) => Promise<string>)
      | undefined;
    expect(callToolRaw).toBeDefined();

    await callToolRaw?.(JSON.stringify({ name: "my_tool" }));
    await callToolRaw?.(JSON.stringify({ name: "my_tool" }));
    const result = await callToolRaw?.(JSON.stringify({ name: "my_tool" }));
    const parsed = JSON.parse(result ?? "{}") as Record<string, unknown>;

    expect(parsed.__koi_ok).toBe(false);
    expect(parsed.__koi_error).toContain("budget exceeded");
    expect(bridge.callCount()).toBe(3);
  });

  test("handles tool execution errors", async () => {
    const failingTool = createMockTool("fail_tool", () => {
      throw new Error("tool crashed");
    });
    const tools = new Map([["fail_tool", failingTool]]);
    const bridge = createToolBridge({ tools });
    const callToolRaw = bridge.hostFunctions.get("__callToolRaw") as
      | ((s: string) => Promise<string>)
      | undefined;
    expect(callToolRaw).toBeDefined();

    const result = await callToolRaw?.(JSON.stringify({ name: "fail_tool" }));
    const parsed = JSON.parse(result ?? "{}") as Record<string, unknown>;

    expect(parsed.__koi_ok).toBe(false);
    expect(parsed.__koi_error).toBe("tool crashed");
  });

  test("handles invalid JSON input", async () => {
    const tools = new Map<string, Tool>();
    const bridge = createToolBridge({ tools });
    const callToolRaw = bridge.hostFunctions.get("__callToolRaw") as
      | ((s: string) => Promise<string>)
      | undefined;
    expect(callToolRaw).toBeDefined();

    const result = await callToolRaw?.("not valid json");
    const parsed = JSON.parse(result ?? "{}") as Record<string, unknown>;

    expect(parsed.__koi_ok).toBe(false);
    expect(parsed.__koi_error).toContain("Invalid JSON");
  });

  test("handles missing tool name", async () => {
    const tools = new Map<string, Tool>();
    const bridge = createToolBridge({ tools });
    const callToolRaw = bridge.hostFunctions.get("__callToolRaw") as
      | ((s: string) => Promise<string>)
      | undefined;
    expect(callToolRaw).toBeDefined();

    const result = await callToolRaw?.(JSON.stringify({ args: {} }));
    const parsed = JSON.parse(result ?? "{}") as Record<string, unknown>;

    expect(parsed.__koi_ok).toBe(false);
    expect(parsed.__koi_error).toContain("name must be a string");
  });

  test("passes args to tool correctly", async () => {
    // Justified `let`: captured args for assertion.
    let capturedArgs: JsonObject | undefined;
    const tool = createMockTool("my_tool", (args) => {
      capturedArgs = args;
      return { ok: true };
    });
    const tools = new Map([["my_tool", tool]]);
    const bridge = createToolBridge({ tools });
    const callToolRaw = bridge.hostFunctions.get("__callToolRaw") as
      | ((s: string) => Promise<string>)
      | undefined;
    expect(callToolRaw).toBeDefined();

    await callToolRaw?.(JSON.stringify({ name: "my_tool", args: { path: "/test" } }));

    expect(capturedArgs).toEqual({ path: "/test" });
  });

  test("tracks call count", async () => {
    const tools = new Map([["my_tool", createMockTool("my_tool")]]);
    const bridge = createToolBridge({ tools });
    const callToolRaw = bridge.hostFunctions.get("__callToolRaw") as
      | ((s: string) => Promise<string>)
      | undefined;
    expect(callToolRaw).toBeDefined();

    expect(bridge.callCount()).toBe(0);
    await callToolRaw?.(JSON.stringify({ name: "my_tool" }));
    expect(bridge.callCount()).toBe(1);
    await callToolRaw?.(JSON.stringify({ name: "my_tool" }));
    expect(bridge.callCount()).toBe(2);
  });

  test("preamble defines callTool function with envelope protocol", () => {
    const tools = new Map<string, Tool>();
    const bridge = createToolBridge({ tools });

    expect(bridge.preamble).toContain("function callTool");
    expect(bridge.preamble).toContain("__callToolRaw");
    expect(bridge.preamble).toContain("__koi_ok");
  });

  test("provides one host function", () => {
    const tools = new Map<string, Tool>();
    const bridge = createToolBridge({ tools });
    expect(bridge.hostFunctions.size).toBe(1);
    expect(bridge.hostFunctions.has("__callToolRaw")).toBe(true);
  });
});
