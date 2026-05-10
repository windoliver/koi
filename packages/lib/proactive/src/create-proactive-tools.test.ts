import { describe, expect, test } from "bun:test";
import { createProactiveTools, PROACTIVE_TOOL_NAMES } from "./create-proactive-tools.js";
import { createSchedulerStub } from "./test-helpers.js";

describe("createProactiveTools", () => {
  test("returns sleep, cron, and monitor tools in stable order", () => {
    const stub = createSchedulerStub();
    const tools = createProactiveTools({ scheduler: stub.component });
    // notify is omitted when resolveChannel is not set; filter it out for comparison.
    expect(tools.map((t) => t.descriptor.name)).toEqual(
      PROACTIVE_TOOL_NAMES.filter((n) => n !== "notify"),
    );
  });

  test("all tools share the primordial origin", () => {
    const stub = createSchedulerStub();
    const tools = createProactiveTools({ scheduler: stub.component });
    for (const tool of tools) {
      expect(tool.origin).toBe("primordial");
    }
  });
});
