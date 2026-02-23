import { describe, expect, mock, test } from "bun:test";
import type { ForgeHealthConfig } from "./config.js";
import { createToolHealthTracker } from "./tool-health.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockForgeStore() {
  return {
    save: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    load: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
    search: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
    remove: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    update: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    exists: mock(() => Promise.resolve({ ok: true as const, value: false })),
  };
}

function createMockSnapshotStore() {
  return {
    record: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    get: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
    list: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
    history: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
    latest: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
  };
}

function createTestConfig(overrides?: Partial<ForgeHealthConfig>): ForgeHealthConfig {
  return {
    resolveBrickId: (toolId: string) =>
      toolId.startsWith("forged-") ? `brick-${toolId}` : undefined,
    forgeStore: createMockForgeStore(),
    snapshotStore: createMockSnapshotStore(),
    windowSize: 4,
    quarantineThreshold: 0.5,
    maxRecentFailures: 3,
    clock: () => 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolHealthTracker", () => {
  test("recordSuccess creates a snapshot with correct metrics", () => {
    const tracker = createToolHealthTracker(createTestConfig());
    tracker.recordSuccess("forged-tool-1", 50);

    const snap = tracker.getSnapshot("forged-tool-1");
    expect(snap).toBeDefined();
    expect(snap?.metrics.usageCount).toBe(1);
    expect(snap?.metrics.successRate).toBe(1);
    expect(snap?.metrics.errorRate).toBe(0);
    expect(snap?.metrics.avgLatencyMs).toBe(50);
    expect(snap?.state).toBe("healthy");
  });

  test("recordFailure updates error rate and stores failure record", () => {
    const tracker = createToolHealthTracker(createTestConfig());
    tracker.recordFailure("forged-tool-1", 100, "timeout");

    const snap = tracker.getSnapshot("forged-tool-1");
    expect(snap).toBeDefined();
    expect(snap?.metrics.errorRate).toBe(1);
    expect(snap?.recentFailures).toHaveLength(1);
    expect(snap?.recentFailures[0]?.error).toBe("timeout");
    expect(snap?.recentFailures[0]?.latencyMs).toBe(100);
  });

  test("recent failures capped at maxRecentFailures", () => {
    const tracker = createToolHealthTracker(createTestConfig({ maxRecentFailures: 2 }));
    tracker.recordFailure("forged-tool-1", 10, "err-1");
    tracker.recordFailure("forged-tool-1", 20, "err-2");
    tracker.recordFailure("forged-tool-1", 30, "err-3");

    const snap = tracker.getSnapshot("forged-tool-1");
    expect(snap?.recentFailures).toHaveLength(2);
    expect(snap?.recentFailures[0]?.error).toBe("err-2");
    expect(snap?.recentFailures[1]?.error).toBe("err-3");
  });

  test("state transitions: healthy → degraded when error rate approaches threshold", () => {
    const tracker = createToolHealthTracker(
      createTestConfig({ windowSize: 4, quarantineThreshold: 0.5 }),
    );
    // 2 success + 1 failure = 33% error rate, >= 0.5 * 0.75 = 37.5%? No → healthy
    tracker.recordSuccess("t", 10);
    tracker.recordSuccess("t", 10);
    tracker.recordFailure("t", 10, "e1");
    expect(tracker.getSnapshot("t")?.state).toBe("healthy");

    // 2 success + 2 failure = 50% error rate, >= 37.5% → degraded (but < threshold with full window)
    tracker.recordFailure("t", 10, "e2");
    // 4 entries, errorRate = 0.5, >= threshold 0.5, usageCount 4 === windowSize 4 → quarantined
    expect(tracker.getSnapshot("t")?.state).toBe("quarantined");
  });

  test("quarantine is terminal — subsequent records are ignored", () => {
    const tracker = createToolHealthTracker(
      createTestConfig({ windowSize: 2, quarantineThreshold: 0.5 }),
    );
    tracker.recordFailure("t", 10, "e1");
    tracker.recordFailure("t", 10, "e2");
    expect(tracker.getSnapshot("t")?.state).toBe("quarantined");

    // Further records ignored
    tracker.recordSuccess("t", 10);
    expect(tracker.getSnapshot("t")?.metrics.usageCount).toBe(2);
    expect(tracker.isQuarantined("t")).toBe(true);
  });

  test("isQuarantined returns false for unknown tool", () => {
    const tracker = createToolHealthTracker(createTestConfig());
    expect(tracker.isQuarantined("unknown")).toBe(false);
  });

  test("getSnapshot returns undefined for unknown tool", () => {
    const tracker = createToolHealthTracker(createTestConfig());
    expect(tracker.getSnapshot("unknown")).toBeUndefined();
  });

  test("checkAndQuarantine calls forgeStore.update and snapshotStore.record", async () => {
    const forgeStore = createMockForgeStore();
    const snapshotStore = createMockSnapshotStore();
    const onQuarantine = mock(() => {});

    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        snapshotStore,
        onQuarantine,
        windowSize: 2,
        quarantineThreshold: 0.5,
      }),
    );

    tracker.recordFailure("forged-tool-1", 10, "e1");
    tracker.recordFailure("forged-tool-1", 10, "e2");
    expect(tracker.isQuarantined("forged-tool-1")).toBe(true);

    const result = await tracker.checkAndQuarantine("forged-tool-1");
    expect(result).toBe(true);
    expect(forgeStore.update).toHaveBeenCalledTimes(1);
    expect(forgeStore.update).toHaveBeenCalledWith("brick-forged-tool-1", { lifecycle: "failed" });
    expect(snapshotStore.record).toHaveBeenCalledTimes(1);
    expect(onQuarantine).toHaveBeenCalledWith("brick-forged-tool-1");
  });

  test("checkAndQuarantine returns false when tool is not quarantined", async () => {
    const tracker = createToolHealthTracker(createTestConfig());
    tracker.recordSuccess("forged-tool-1", 10);

    const result = await tracker.checkAndQuarantine("forged-tool-1");
    expect(result).toBe(false);
  });

  test("checkAndQuarantine returns false for unknown tool", async () => {
    const tracker = createToolHealthTracker(createTestConfig());
    const result = await tracker.checkAndQuarantine("unknown");
    expect(result).toBe(false);
  });

  test("checkAndQuarantine throws when forgeStore.update fails", async () => {
    const forgeStore = createMockForgeStore();
    forgeStore.update = mock(() =>
      Promise.resolve({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "db down", retryable: false },
      }),
    );

    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        windowSize: 2,
        quarantineThreshold: 0.5,
      }),
    );
    tracker.recordFailure("forged-tool-1", 10, "e1");
    tracker.recordFailure("forged-tool-1", 10, "e2");

    await expect(tracker.checkAndQuarantine("forged-tool-1")).rejects.toThrow(
      "Failed to update forge store",
    );
  });

  test("checkAndQuarantine throws when snapshotStore.record fails", async () => {
    const snapshotStore = createMockSnapshotStore();
    snapshotStore.record = mock(() =>
      Promise.resolve({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "storage full", retryable: false },
      }),
    );

    const tracker = createToolHealthTracker(
      createTestConfig({
        snapshotStore,
        windowSize: 2,
        quarantineThreshold: 0.5,
      }),
    );
    tracker.recordFailure("forged-tool-1", 10, "e1");
    tracker.recordFailure("forged-tool-1", 10, "e2");

    await expect(tracker.checkAndQuarantine("forged-tool-1")).rejects.toThrow(
      "Failed to record quarantine snapshot",
    );
  });

  test("checkAndQuarantine returns false when brickId not resolvable", async () => {
    const tracker = createToolHealthTracker(
      createTestConfig({
        windowSize: 2,
        quarantineThreshold: 0.5,
        resolveBrickId: () => undefined,
      }),
    );
    tracker.recordFailure("tool-1", 10, "e1");
    tracker.recordFailure("tool-1", 10, "e2");

    const result = await tracker.checkAndQuarantine("tool-1");
    expect(result).toBe(false);
  });

  test("getAllSnapshots returns all tracked tools", () => {
    const tracker = createToolHealthTracker(createTestConfig());
    tracker.recordSuccess("forged-tool-1", 10);
    tracker.recordSuccess("forged-tool-2", 20);

    const all = tracker.getAllSnapshots();
    expect(all).toHaveLength(2);
    const ids = all.map((s) => s.toolId).sort();
    expect(ids).toEqual(["forged-tool-1", "forged-tool-2"]);
  });

  test("ring buffer wraps correctly", () => {
    // windowSize=3, threshold=0.8: avoid quarantine while testing wrap
    const tracker = createToolHealthTracker(
      createTestConfig({ windowSize: 3, quarantineThreshold: 0.8 }),
    );
    // Fill 3 slots: 1 fail + 2 success = 33% error rate < 80% threshold
    tracker.recordFailure("t", 10, "e1");
    tracker.recordSuccess("t", 10);
    tracker.recordSuccess("t", 10);
    // Ring wraps — next 3 records overwrite all entries with successes
    tracker.recordSuccess("t", 5);
    tracker.recordSuccess("t", 5);
    tracker.recordSuccess("t", 5);

    const snap = tracker.getSnapshot("t");
    // After wrap: 3 successes in window of 3
    expect(snap?.metrics.successRate).toBe(1);
    expect(snap?.metrics.errorRate).toBe(0);
    expect(snap?.metrics.avgLatencyMs).toBe(5);
  });

  test("degraded state when error rate is in warning zone", () => {
    // threshold=0.8, degraded zone = 0.6-0.8
    const tracker = createToolHealthTracker(
      createTestConfig({ windowSize: 4, quarantineThreshold: 0.8 }),
    );
    tracker.recordSuccess("t", 10);
    tracker.recordFailure("t", 10, "e1");
    tracker.recordFailure("t", 10, "e2");
    tracker.recordFailure("t", 10, "e3");
    // 3/4 = 75% error rate, >= 0.8 * 0.75 = 60% → degraded (< threshold 0.8)
    expect(tracker.getSnapshot("t")?.state).toBe("degraded");
  });

  test("injectable clock is used for timestamps", () => {
    // let: incrementing clock
    let time = 5000;
    const tracker = createToolHealthTracker(createTestConfig({ clock: () => time }));
    tracker.recordFailure("forged-tool-1", 10, "err");
    time = 6000;
    tracker.recordFailure("forged-tool-1", 20, "err2");

    const snap = tracker.getSnapshot("forged-tool-1");
    expect(snap?.lastUpdatedAt).toBe(6000);
    expect(snap?.recentFailures[0]?.timestamp).toBe(5000);
    expect(snap?.recentFailures[1]?.timestamp).toBe(6000);
  });
});
