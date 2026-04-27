import { describe, expect, test } from "bun:test";
import { createProactiveTools } from "./create-proactive-tools.js";
import { createSchedulerStub } from "./test-helpers.js";

describe("createProactiveTools", () => {
  test("returns sleep, cancel_sleep, schedule_cron, cancel_schedule in that order", () => {
    const stub = createSchedulerStub();
    const tools = createProactiveTools({ scheduler: stub.component });
    expect(tools.map((t) => t.descriptor.name)).toEqual([
      "sleep",
      "cancel_sleep",
      "schedule_cron",
      "cancel_schedule",
    ]);
  });

  test("all tools share the primordial origin", () => {
    const stub = createSchedulerStub();
    const tools = createProactiveTools({ scheduler: stub.component });
    for (const tool of tools) {
      expect(tool.origin).toBe("primordial");
    }
  });
});
