import { describe, expect, test } from "bun:test";
import { COMPONENT_PRIORITY } from "@koi/core";
import { createProactiveToolsProvider } from "./provider.js";
import { createSchedulerStub } from "./test-helpers.js";

describe("createProactiveToolsProvider", () => {
  test("returns a ComponentProvider named 'proactive' at BUNDLED priority by default", () => {
    const stub = createSchedulerStub();
    const provider = createProactiveToolsProvider({ scheduler: stub.component });
    expect(provider.name).toBe("proactive");
    expect(provider.priority).toBe(COMPONENT_PRIORITY.BUNDLED);
  });

  test("respects caller-supplied priority override", () => {
    const stub = createSchedulerStub();
    const provider = createProactiveToolsProvider({
      scheduler: stub.component,
      priority: 999,
    });
    expect(provider.priority).toBe(999);
  });
});
