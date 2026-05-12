import { describe, expect, test } from "bun:test";
import { createProactiveTools } from "./create-proactive-tools.js";
import { createSchedulerStub } from "./test-helpers.js";

describe("createProactiveTools", () => {
  test("returns sleep, cron, and monitor tools in stable order (no channel = no brief, no notify)", () => {
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

  test("includes brief tools and notify when resolveChannel is supplied", () => {
    const stub = createSchedulerStub();
    const tools = createProactiveTools({
      scheduler: stub.component,
      resolveChannel: () => undefined,
      channelNames: () => ["slack"],
    });
    expect(tools.map((t) => t.descriptor.name)).toEqual([
      "sleep",
      "cancel_sleep",
      "schedule_cron",
      "cancel_schedule",
      "create_monitor",
      "list_monitors",
      "update_monitor",
      "cancel_monitor",
      "create_brief",
      "list_briefs",
      "update_brief",
      "cancel_brief",
      "notify",
    ]);
  });

  test("omits brief tools and notify when resolveChannel is supplied but channelNames is empty", () => {
    // A resolver that can never resolve any name provides no delivery
    // path. Registering brief/notify in this case would let the model
    // schedule recurring wakes that can never deliver — silent failure.
    const stub = createSchedulerStub();
    const tools = createProactiveTools({
      scheduler: stub.component,
      resolveChannel: () => undefined,
      channelNames: () => [],
    });
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
