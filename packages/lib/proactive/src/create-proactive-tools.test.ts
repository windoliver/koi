import { describe, expect, test } from "bun:test";
import { createProactiveTools } from "./create-proactive-tools.js";
import { createSchedulerStub } from "./test-helpers.js";

describe("createProactiveTools", () => {
  test("returns sleep, cron, and monitor tools in stable order", () => {
    const stub = createSchedulerStub();
    const tools = createProactiveTools({ scheduler: stub.component });
    expect(tools.map((t) => t.descriptor.name)).toEqual([
      "sleep",
      "cancel_sleep",
      "schedule_cron",
      "cancel_schedule",
      "create_monitor",
      "list_monitors",
      "update_monitor",
      "cancel_monitor",
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
