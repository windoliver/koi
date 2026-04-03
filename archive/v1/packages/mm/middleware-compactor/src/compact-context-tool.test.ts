import { describe, expect, mock, test } from "bun:test";
import { createCompactContextTool } from "./compact-context-tool.js";

describe("createCompactContextTool", () => {
  function createDeps() {
    return {
      scheduleCompaction: mock(() => {}),
      formatOccupancy: () => "Context: 85% (170K/200K)",
    };
  }

  test("descriptor name is 'compact_context'", () => {
    const tool = createCompactContextTool(createDeps());
    expect(tool.descriptor.name).toBe("compact_context");
  });

  test("descriptor inputSchema has empty properties", () => {
    const tool = createCompactContextTool(createDeps());
    expect(tool.descriptor.inputSchema).toEqual({
      type: "object",
      properties: {},
    });
  });

  test("policy is 'verified'", () => {
    const tool = createCompactContextTool(createDeps());
    expect(tool.policy.sandbox).toBe(false);
  });

  test("execute() calls scheduleCompaction", async () => {
    const deps = createDeps();
    const tool = createCompactContextTool(deps);
    await tool.execute({});
    expect(deps.scheduleCompaction).toHaveBeenCalledTimes(1);
  });

  test("execute() returns string containing occupancy info", async () => {
    const deps = createDeps();
    const tool = createCompactContextTool(deps);
    const result = await tool.execute({});
    expect(typeof result).toBe("string");
    expect(result as string).toContain("85%");
    expect(result as string).toContain("scheduled");
  });

  test("execute() does not throw", async () => {
    const deps = createDeps();
    const tool = createCompactContextTool(deps);
    await expect(tool.execute({})).resolves.toBeDefined();
  });
});
