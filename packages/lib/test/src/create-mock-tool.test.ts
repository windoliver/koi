import { describe, expect, test } from "bun:test";
import type { ToolRequest } from "@koi/core";
import { createMockTool } from "./create-mock-tool.js";

const request: ToolRequest = { toolId: "search", input: { q: "hello" } };

describe("createMockTool", () => {
  test("descriptor uses config name and default description", () => {
    const { descriptor } = createMockTool({ name: "search" });
    expect(descriptor.name).toBe("search");
    expect(descriptor.description).toBe("Mock tool: search");
    expect(descriptor.inputSchema).toEqual({ type: "object" });
  });

  test("static output is returned and recorded", async () => {
    const { handle, calls } = createMockTool({ name: "echo", output: { ok: true } });
    const response = await handle(request);
    expect(response.output).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toEqual(request);
  });

  test("dynamic handler wins over static output", async () => {
    const { handle } = createMockTool({
      name: "handler-wins",
      output: { ignored: true },
      handler: async (req) => ({ output: { echoed: req.input } }),
    });
    const response = await handle(request);
    expect(response.output).toEqual({ echoed: { q: "hello" } });
  });

  test("callCount and reset", async () => {
    const { handle, callCount, reset } = createMockTool({ name: "reset-me" });
    await handle(request);
    await handle(request);
    expect(callCount()).toBe(2);
    reset();
    expect(callCount()).toBe(0);
  });

  test("no config → null output", async () => {
    const { handle } = createMockTool({ name: "null-out" });
    const response = await handle(request);
    expect(response.output).toBeNull();
  });
});
