import { describe, expect, test } from "bun:test";
import { createTrajectoryBuffer } from "./trajectory-buffer.js";
import type { TrajectoryEntry } from "./types.js";

function makeEntry(overrides?: Partial<TrajectoryEntry>): TrajectoryEntry {
  return {
    turnIndex: 0,
    timestamp: 1000,
    kind: "tool_call",
    identifier: "tool-a",
    outcome: "success",
    durationMs: 50,
    ...overrides,
  };
}

describe("createTrajectoryBuffer", () => {
  test("record and flush roundtrip", () => {
    const buf = createTrajectoryBuffer(10);
    buf.record(makeEntry());
    buf.record(makeEntry({ turnIndex: 1 }));
    const entries = buf.flush();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.turnIndex).toBe(0);
    expect(entries[1]?.turnIndex).toBe(1);
  });

  test("flush clears the buffer", () => {
    const buf = createTrajectoryBuffer(10);
    buf.record(makeEntry());
    buf.flush();
    expect(buf.size()).toBe(0);
    expect(buf.flush()).toHaveLength(0);
  });

  test("size reports current entry count", () => {
    const buf = createTrajectoryBuffer(10);
    expect(buf.size()).toBe(0);
    buf.record(makeEntry());
    expect(buf.size()).toBe(1);
    buf.record(makeEntry());
    expect(buf.size()).toBe(2);
  });

  test("capacity returns max entries", () => {
    const buf = createTrajectoryBuffer(42);
    expect(buf.capacity()).toBe(42);
  });

  test("FIFO eviction when buffer is full", () => {
    const buf = createTrajectoryBuffer(3);
    buf.record(makeEntry({ timestamp: 1 }));
    buf.record(makeEntry({ timestamp: 2 }));
    buf.record(makeEntry({ timestamp: 3 }));
    const evicted = buf.record(makeEntry({ timestamp: 4 }));

    expect(evicted).toBe(1);
    expect(buf.size()).toBe(3);

    const entries = buf.flush();
    expect(entries[0]?.timestamp).toBe(2);
    expect(entries[2]?.timestamp).toBe(4);
  });

  test("record returns 0 when no eviction needed", () => {
    const buf = createTrajectoryBuffer(10);
    const evicted = buf.record(makeEntry());
    expect(evicted).toBe(0);
  });

  test("aggregated stats track successes", () => {
    const buf = createTrajectoryBuffer(10);
    buf.record(makeEntry({ identifier: "tool-a", outcome: "success" }));
    buf.record(makeEntry({ identifier: "tool-a", outcome: "success" }));

    const stats = buf.getStats();
    const toolA = stats.get("tool-a");
    expect(toolA).toBeDefined();
    expect(toolA?.successes).toBe(2);
    expect(toolA?.failures).toBe(0);
    expect(toolA?.invocations).toBe(2);
  });

  test("aggregated stats track failures", () => {
    const buf = createTrajectoryBuffer(10);
    buf.record(makeEntry({ identifier: "tool-a", outcome: "failure" }));
    buf.record(makeEntry({ identifier: "tool-a", outcome: "success" }));

    const stats = buf.getStats();
    const toolA = stats.get("tool-a");
    expect(toolA?.successes).toBe(1);
    expect(toolA?.failures).toBe(1);
  });

  test("aggregated stats track retries", () => {
    const buf = createTrajectoryBuffer(10);
    buf.record(makeEntry({ identifier: "model-x", outcome: "retry", kind: "model_call" }));

    const stats = buf.getStats();
    const modelX = stats.get("model-x");
    expect(modelX?.retries).toBe(1);
    expect(modelX?.kind).toBe("model_call");
  });

  test("aggregated stats track total duration", () => {
    const buf = createTrajectoryBuffer(10);
    buf.record(makeEntry({ identifier: "tool-a", durationMs: 100 }));
    buf.record(makeEntry({ identifier: "tool-a", durationMs: 200 }));

    const stats = buf.getStats();
    expect(stats.get("tool-a")?.totalDurationMs).toBe(300);
  });

  test("aggregated stats track lastSeenMs", () => {
    const buf = createTrajectoryBuffer(10);
    buf.record(makeEntry({ identifier: "tool-a", timestamp: 1000 }));
    buf.record(makeEntry({ identifier: "tool-a", timestamp: 2000 }));

    const stats = buf.getStats();
    expect(stats.get("tool-a")?.lastSeenMs).toBe(2000);
  });

  test("aggregated stats separate by identifier", () => {
    const buf = createTrajectoryBuffer(10);
    buf.record(makeEntry({ identifier: "tool-a" }));
    buf.record(makeEntry({ identifier: "tool-b" }));

    const stats = buf.getStats();
    expect(stats.size).toBe(2);
    expect(stats.get("tool-a")?.invocations).toBe(1);
    expect(stats.get("tool-b")?.invocations).toBe(1);
  });

  test("resetStats clears aggregated stats", () => {
    const buf = createTrajectoryBuffer(10);
    buf.record(makeEntry());
    buf.resetStats();

    const stats = buf.getStats();
    expect(stats.size).toBe(0);
  });

  test("stats persist across flush", () => {
    const buf = createTrajectoryBuffer(10);
    buf.record(makeEntry({ identifier: "tool-a" }));
    buf.flush();

    const stats = buf.getStats();
    expect(stats.get("tool-a")?.invocations).toBe(1);
  });
});
