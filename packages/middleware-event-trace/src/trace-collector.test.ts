import { beforeEach, describe, expect, test } from "bun:test";
import type { TraceCollector } from "./trace-collector.js";
import { createTraceCollector } from "./trace-collector.js";

describe("createTraceCollector", () => {
  let collector: TraceCollector;
  let tick: number;
  const clock = (): number => tick;

  beforeEach(() => {
    tick = 1000;
    collector = createTraceCollector(clock);
  });

  test("record assigns monotonic event indices", () => {
    const e0 = collector.record(0, {
      kind: "model_call",
      request: {},
      response: {},
      durationMs: 10,
    });
    const e1 = collector.record(0, {
      kind: "tool_call",
      toolId: "t1",
      callId: "c1",
      input: {},
      output: {},
      durationMs: 5,
    });

    expect(e0.eventIndex).toBe(0);
    expect(e1.eventIndex).toBe(1);
    expect(e0.turnIndex).toBe(0);
    expect(e1.turnIndex).toBe(0);
    expect(e0.timestamp).toBe(1000);
  });

  test("currentIndex returns the next assignable index", () => {
    expect(collector.currentIndex()).toBe(0);

    collector.record(0, {
      kind: "model_call",
      request: {},
      response: {},
      durationMs: 10,
    });
    expect(collector.currentIndex()).toBe(1);

    collector.record(0, {
      kind: "model_call",
      request: {},
      response: {},
      durationMs: 10,
    });
    expect(collector.currentIndex()).toBe(2);
  });

  test("reset clears events but preserves counter", () => {
    collector.record(0, {
      kind: "model_call",
      request: {},
      response: {},
      durationMs: 10,
    });
    collector.record(0, {
      kind: "model_call",
      request: {},
      response: {},
      durationMs: 10,
    });

    expect(collector.getEvents()).toHaveLength(2);
    expect(collector.currentIndex()).toBe(2);

    collector.reset();

    expect(collector.getEvents()).toHaveLength(0);
    // Counter is preserved across resets
    expect(collector.currentIndex()).toBe(2);

    const e2 = collector.record(1, {
      kind: "model_call",
      request: {},
      response: {},
      durationMs: 10,
    });
    expect(e2.eventIndex).toBe(2);
  });

  test("getEvents returns a copy of events", () => {
    collector.record(0, {
      kind: "model_call",
      request: {},
      response: {},
      durationMs: 10,
    });
    const events1 = collector.getEvents();
    const events2 = collector.getEvents();

    expect(events1).toHaveLength(1);
    expect(events1).toEqual(events2);
    // Verify it's a copy (different array reference)
    expect(events1).not.toBe(events2);
  });
});
