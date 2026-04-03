import { describe, expect, test } from "bun:test";
import type { JsonObject, ToolDescriptor, ToolResponse } from "@koi/core";
import type { SelfTestTool } from "../types.js";
import { runToolChecks } from "./tool-checks.js";

const TIMEOUT = 5_000;

const VALID_DESCRIPTOR: ToolDescriptor = {
  name: "search",
  description: "Search the web",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

describe("runToolChecks", () => {
  test("returns skip when no tools provided", async () => {
    const results = await runToolChecks([], TIMEOUT);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("skip");
  });

  test("all checks pass for a valid tool descriptor", async () => {
    const tool: SelfTestTool = { descriptor: VALID_DESCRIPTOR };
    const results = await runToolChecks([tool], TIMEOUT);
    // name + description + inputSchema = 3 checks
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.status).toBe("pass");
      expect(r.category).toBe("tools");
    }
  });

  test("fails when descriptor name is empty", async () => {
    const tool: SelfTestTool = {
      descriptor: { ...VALID_DESCRIPTOR, name: "" },
    };
    const results = await runToolChecks([tool], TIMEOUT);
    const nameCheck = results.find((r) => r.name.includes("has valid name"));
    expect(nameCheck?.status).toBe("fail");
  });

  test("fails when descriptor description is empty", async () => {
    const tool: SelfTestTool = {
      descriptor: { ...VALID_DESCRIPTOR, description: "" },
    };
    const results = await runToolChecks([tool], TIMEOUT);
    const descCheck = results.find((r) => r.name.includes("has description"));
    expect(descCheck?.status).toBe("fail");
  });

  test("passes when handler returns valid ToolResponse", async () => {
    const tool: SelfTestTool = {
      descriptor: VALID_DESCRIPTOR,
      async handler(_args: JsonObject): Promise<ToolResponse> {
        return { output: { result: "ok" } };
      },
    };
    const results = await runToolChecks([tool], TIMEOUT);
    const handlerCheck = results.find((r) => r.name.includes("handler returns"));
    expect(handlerCheck?.status).toBe("pass");
  });

  test("fails when handler returns null", async () => {
    const tool: SelfTestTool = {
      descriptor: VALID_DESCRIPTOR,
      async handler(): Promise<ToolResponse> {
        return null as unknown as ToolResponse;
      },
    };
    const results = await runToolChecks([tool], TIMEOUT);
    const handlerCheck = results.find((r) => r.name.includes("handler returns"));
    expect(handlerCheck?.status).toBe("fail");
    expect(handlerCheck?.error?.message).toContain("undefined/null");
  });

  test("fails when handler throws", async () => {
    const tool: SelfTestTool = {
      descriptor: VALID_DESCRIPTOR,
      async handler(): Promise<ToolResponse> {
        throw new Error("handler boom");
      },
    };
    const results = await runToolChecks([tool], TIMEOUT);
    const handlerCheck = results.find((r) => r.name.includes("handler returns"));
    expect(handlerCheck?.status).toBe("fail");
    expect(handlerCheck?.error?.message).toBe("handler boom");
  });

  test("does not run handler check when handler is not provided", async () => {
    const tool: SelfTestTool = { descriptor: VALID_DESCRIPTOR };
    const results = await runToolChecks([tool], TIMEOUT);
    // Only 3 descriptor checks, no handler check
    expect(results).toHaveLength(3);
  });

  test("handles multiple tools", async () => {
    const tools: readonly SelfTestTool[] = [
      { descriptor: VALID_DESCRIPTOR },
      { descriptor: { ...VALID_DESCRIPTOR, name: "calculator" } },
    ];
    const results = await runToolChecks(tools, TIMEOUT);
    // 3 checks per tool = 6 total
    expect(results).toHaveLength(6);
  });
});
