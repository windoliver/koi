import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { createStubAdapter } from "./stub-adapter.js";

describe("createStubAdapter", () => {
  test("yields a single done event with empty content", async () => {
    const adapter = createStubAdapter();
    const events: EngineEvent[] = [];

    for await (const event of adapter.stream({ kind: "text", text: "hello" })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("done");

    const done = events[0] as Extract<EngineEvent, { readonly kind: "done" }>;
    expect(done.output.stopReason).toBe("completed");
    expect(done.output.content).toEqual([]);
    expect(done.output.metrics.totalTokens).toBe(0);
  });

  test("has text capability only", () => {
    const adapter = createStubAdapter();
    expect(adapter.capabilities.text).toBe(true);
    expect(adapter.capabilities.images).toBe(false);
    expect(adapter.capabilities.files).toBe(false);
    expect(adapter.capabilities.audio).toBe(false);
  });

  test("has engineId stub", () => {
    const adapter = createStubAdapter();
    expect(adapter.engineId).toBe("stub");
  });
});
