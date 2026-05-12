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

  test("installs brief tools and notify when only resolveChannel is supplied (no channelNames)", () => {
    // Direct callers of createProactiveTools may pass `resolveChannel`
    // alone; they assert their resolver can resolve channels. The
    // optional `channelNames` is purely for error-formatting metadata
    // (available_channels listings) and must not gate registration.
    const stub = createSchedulerStub();
    const tools = createProactiveTools({
      scheduler: stub.component,
      resolveChannel: () => undefined,
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

  test("all tools share the primordial origin", () => {
    const stub = createSchedulerStub();
    const tools = createProactiveTools({ scheduler: stub.component });
    for (const tool of tools) {
      expect(tool.origin).toBe("primordial");
    }
  });
});
