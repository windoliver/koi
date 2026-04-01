import { describe, expect, mock, test } from "bun:test";
import type { KoiError } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { ForgeHealthConfig } from "./config.js";
import { computeHealthAction, createToolHealthTracker, type HealthAction } from "./tool-health.js";
import type { DemotionCriteria, ToolHealthMetrics } from "./types.js";
import { DEFAULT_DEMOTION_CRITERIA } from "./types.js";

type StoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KoiError };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockForgeStore(overrides?: Record<string, unknown>) {
  return {
    save: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    load: mock(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          origin: "primordial",
          policy: DEFAULT_UNSANDBOXED_POLICY,
          lastPromotedAt: 0,
          lastDemotedAt: 0,
          ...(overrides ?? {}),
        } as never,
      }),
    ),
    search: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
    remove: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    update: mock(
      (): Promise<StoreResult<undefined>> =>
        Promise.resolve({ ok: true as const, value: undefined }),
    ),
    exists: mock(() => Promise.resolve({ ok: true as const, value: false })),
  };
}

function createMockSnapshotStore() {
  return {
    record: mock(
      (): Promise<StoreResult<undefined>> =>
        Promise.resolve({ ok: true as const, value: undefined }),
    ),
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

function metricsWithRate(errorRate: number, usageCount: number): ToolHealthMetrics {
  return {
    successRate: 1 - errorRate,
    errorRate,
    usageCount,
    avgLatencyMs: 50,
  };
}

// ---------------------------------------------------------------------------
// computeHealthAction — pure function tests (table-driven)
// ---------------------------------------------------------------------------

describe("computeHealthAction", () => {
  const defaultDemotion: DemotionCriteria = {
    ...DEFAULT_DEMOTION_CRITERIA,
    windowSize: 20,
    minSampleSize: 10,
    gracePeriodMs: 3_600_000,
    demotionCooldownMs: 1_800_000,
    errorRateThreshold: 0.3,
  };

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly quarantineMetrics: ToolHealthMetrics;
    readonly demotionMetrics: ToolHealthMetrics;
    readonly currentState: "healthy" | "degraded" | "quarantined";
    readonly isSandboxed: boolean;
    readonly quarantineThreshold: number;
    readonly quarantineWindowSize: number;
    readonly demotionCriteria: DemotionCriteria;
    readonly lastPromotedAt: number;
    readonly lastDemotedAt: number;
    readonly now: number;
    readonly expected: HealthAction;
  }> = [
    {
      name: "quarantined state is terminal",
      quarantineMetrics: metricsWithRate(0, 0),
      demotionMetrics: metricsWithRate(0, 0),
      currentState: "quarantined",
      isSandboxed: false,
      quarantineThreshold: 0.5,
      quarantineWindowSize: 10,
      demotionCriteria: defaultDemotion,
      lastPromotedAt: 0,
      lastDemotedAt: 0,
      now: 100_000,
      expected: { state: "quarantined", action: "none" },
    },
    {
      name: "quarantine triggers at threshold with full window",
      quarantineMetrics: metricsWithRate(0.6, 10),
      demotionMetrics: metricsWithRate(0.4, 20),
      currentState: "healthy",
      isSandboxed: false,
      quarantineThreshold: 0.5,
      quarantineWindowSize: 10,
      demotionCriteria: defaultDemotion,
      lastPromotedAt: 0,
      lastDemotedAt: 0,
      now: 100_000_000,
      expected: { state: "quarantined", action: "quarantine" },
    },
    {
      name: "demotion triggers at threshold with sufficient samples",
      quarantineMetrics: metricsWithRate(0.2, 10),
      demotionMetrics: metricsWithRate(0.35, 15),
      currentState: "healthy",
      isSandboxed: false,
      quarantineThreshold: 0.5,
      quarantineWindowSize: 10,
      demotionCriteria: defaultDemotion,
      lastPromotedAt: 0,
      lastDemotedAt: 0,
      now: 100_000_000,
      expected: { state: "degraded", action: "demote" },
    },
    {
      name: "grace period prevents demotion",
      quarantineMetrics: metricsWithRate(0.2, 10),
      demotionMetrics: metricsWithRate(0.35, 15),
      currentState: "healthy",
      isSandboxed: false,
      quarantineThreshold: 0.5,
      quarantineWindowSize: 10,
      demotionCriteria: defaultDemotion,
      lastPromotedAt: 99_000_000, // promoted 1M ms ago, grace period is 3.6M ms
      lastDemotedAt: 0,
      now: 100_000_000,
      expected: { state: "healthy", action: "none" },
    },
    {
      name: "cooldown prevents consecutive demotions",
      quarantineMetrics: metricsWithRate(0.2, 10),
      demotionMetrics: metricsWithRate(0.35, 15),
      currentState: "healthy",
      isSandboxed: false,
      quarantineThreshold: 0.5,
      quarantineWindowSize: 10,
      demotionCriteria: defaultDemotion,
      lastPromotedAt: 0,
      lastDemotedAt: 99_500_000, // demoted 0.5M ms ago, cooldown is 1.8M ms
      now: 100_000_000,
      expected: { state: "healthy", action: "none" },
    },
    {
      name: "sandbox tools skip demotion (already at floor)",
      quarantineMetrics: metricsWithRate(0.2, 10),
      demotionMetrics: metricsWithRate(0.5, 20),
      currentState: "healthy",
      isSandboxed: true,
      quarantineThreshold: 0.5,
      quarantineWindowSize: 10,
      demotionCriteria: defaultDemotion,
      lastPromotedAt: 0,
      lastDemotedAt: 0,
      now: 100_000_000,
      expected: { state: "healthy", action: "none" },
    },
    {
      name: "action is none when thresholds not met",
      quarantineMetrics: metricsWithRate(0.1, 10),
      demotionMetrics: metricsWithRate(0.1, 20),
      currentState: "healthy",
      isSandboxed: false,
      quarantineThreshold: 0.5,
      quarantineWindowSize: 10,
      demotionCriteria: defaultDemotion,
      lastPromotedAt: 0,
      lastDemotedAt: 0,
      now: 100_000_000,
      expected: { state: "healthy", action: "none" },
    },
    {
      name: "degraded state when approaching quarantine threshold",
      quarantineMetrics: metricsWithRate(0.4, 5), // 0.4 >= 0.5 * 0.75 = 0.375
      demotionMetrics: metricsWithRate(0.2, 10),
      currentState: "healthy",
      isSandboxed: true,
      quarantineThreshold: 0.5,
      quarantineWindowSize: 10,
      demotionCriteria: defaultDemotion,
      lastPromotedAt: 0,
      lastDemotedAt: 0,
      now: 100_000_000,
      expected: { state: "degraded", action: "none" },
    },
    {
      name: "insufficient sample size prevents demotion",
      quarantineMetrics: metricsWithRate(0.2, 4),
      demotionMetrics: metricsWithRate(0.5, 5), // below minSampleSize of 10
      currentState: "healthy",
      isSandboxed: false,
      quarantineThreshold: 0.5,
      quarantineWindowSize: 10,
      demotionCriteria: defaultDemotion,
      lastPromotedAt: 0,
      lastDemotedAt: 0,
      now: 100_000_000,
      expected: { state: "healthy", action: "none" },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const result = computeHealthAction(
        c.quarantineMetrics,
        c.demotionMetrics,
        c.currentState,
        c.isSandboxed,
        c.quarantineThreshold,
        c.quarantineWindowSize,
        c.demotionCriteria,
        c.lastPromotedAt,
        c.lastDemotedAt,
        c.now,
      );
      expect(result).toEqual(c.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// ToolHealthTracker — existing tests
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

  test("state transitions: healthy → quarantined when error rate hits threshold", () => {
    const tracker = createToolHealthTracker(
      createTestConfig({ windowSize: 4, quarantineThreshold: 0.5 }),
    );
    // 2 success + 1 failure = 33% error rate → healthy
    tracker.recordSuccess("t", 10);
    tracker.recordSuccess("t", 10);
    tracker.recordFailure("t", 10, "e1");
    expect(tracker.getSnapshot("t")?.state).toBe("healthy");

    // 2 success + 2 failure = 50% error rate, usageCount 4 === windowSize 4 → quarantined
    tracker.recordFailure("t", 10, "e2");
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
    // 2 update calls: 1 for lifecycle → "failed", 1 for fitness flush before eviction
    expect(forgeStore.update).toHaveBeenCalledTimes(2);
    expect(snapshotStore.record).toHaveBeenCalledTimes(1);
    expect(onQuarantine).toHaveBeenCalledWith("brick-forged-tool-1");
  });

  test("checkAndQuarantine preserves state when fitness flush fails transiently", async () => {
    const onFlushError = mock(() => {});
    // let: call counter to make only the fitness-flush update fail
    let updateCallCount = 0;
    const forgeStore = createMockForgeStore();
    forgeStore.update = mock((): Promise<StoreResult<undefined>> => {
      updateCallCount++;
      // First call: lifecycle → "failed" (succeed)
      if (updateCallCount === 1) {
        return Promise.resolve({ ok: true as const, value: undefined });
      }
      // Second call: fitness flush (fail transiently)
      return Promise.resolve({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "transient db error", retryable: true },
      });
    });
    const snapshotStore = createMockSnapshotStore();

    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        snapshotStore,
        windowSize: 2,
        quarantineThreshold: 0.5,
        onFlushError,
      }),
    );

    tracker.recordFailure("forged-tool-1", 10, "e1");
    tracker.recordFailure("forged-tool-1", 10, "e2");
    expect(tracker.isQuarantined("forged-tool-1")).toBe(true);

    await tracker.checkAndQuarantine("forged-tool-1");

    // Fitness flush failed → full state preserved (not evicted to marker)
    const snapshot = tracker.getSnapshot("forged-tool-1");
    expect(snapshot).toBeDefined();
    // Full ring buffer preserved: 2 filled slots, not the evicted marker's 1
    expect(snapshot?.metrics.usageCount).toBe(2);
    expect(onFlushError).toHaveBeenCalled();
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
    // After wrap: 3 successes in quarantine window of 3
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

  test("isQuarantinedAsync returns true from ForgeStore when tool not in local map", async () => {
    const forgeStore = createMockForgeStore({ lifecycle: "failed" });

    const tracker = createToolHealthTracker(createTestConfig({ forgeStore }));

    // Tool was never recorded locally — local map is empty
    expect(tracker.isQuarantined("forged-tool-1")).toBe(false);

    // Async check hits ForgeStore and discovers lifecycle === "failed"
    const result = await tracker.isQuarantinedAsync("forged-tool-1");
    expect(result).toBe(true);

    // After async load, sync check should now also return true
    expect(tracker.isQuarantined("forged-tool-1")).toBe(true);
  });

  test("isQuarantinedAsync returns false when ForgeStore has no failed lifecycle", async () => {
    const forgeStore = createMockForgeStore({ lifecycle: "active" });

    const tracker = createToolHealthTracker(createTestConfig({ forgeStore }));

    const result = await tracker.isQuarantinedAsync("forged-tool-1");
    expect(result).toBe(false);
    expect(tracker.isQuarantined("forged-tool-1")).toBe(false);
  });

  test("isQuarantinedAsync returns false for non-forged tools", async () => {
    const tracker = createToolHealthTracker(createTestConfig());

    // "regular-tool" doesn't resolve to a brick ID
    const result = await tracker.isQuarantinedAsync("regular-tool");
    expect(result).toBe(false);
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

// ---------------------------------------------------------------------------
// Trust demotion — tracker-level tests
// ---------------------------------------------------------------------------

describe("trust demotion", () => {
  test("checkAndDemote updates trust tier in store", async () => {
    const forgeStore = createMockForgeStore({
      origin: "primordial",
      policy: DEFAULT_UNSANDBOXED_POLICY,
    });
    const snapshotStore = createMockSnapshotStore();
    const onDemotion = mock(() => {});

    // Use large enough windows; demotion window=5, quarantine window=3
    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        snapshotStore,
        onDemotion,
        windowSize: 3,
        quarantineThreshold: 0.9, // high threshold to avoid quarantine
        clock: () => 100_000_000,
        demotionCriteria: {
          errorRateThreshold: 0.3,
          windowSize: 5,
          minSampleSize: 3,
          gracePeriodMs: 1000,
          demotionCooldownMs: 1000,
        },
      }),
    );

    // Record failures to exceed demotion threshold (>30% error rate over 5 entries)
    tracker.recordFailure("forged-tool-1", 10, "e1");
    tracker.recordFailure("forged-tool-1", 10, "e2");
    tracker.recordSuccess("forged-tool-1", 10);
    tracker.recordSuccess("forged-tool-1", 10);
    tracker.recordFailure("forged-tool-1", 10, "e3");
    // 3/5 = 60% error rate > 30% demotion threshold, sample size 5 >= minSampleSize 3

    const result = await tracker.checkAndDemote("forged-tool-1");
    expect(result).toBe(true);

    // Verify store was updated with demoted trust tier
    expect(forgeStore.update).toHaveBeenCalledTimes(1);
    const updateCall = forgeStore.update.mock.calls[0] as unknown[];
    expect(updateCall[1]).toEqual(expect.objectContaining({ policy: DEFAULT_SANDBOXED_POLICY }));
  });

  test("checkAndDemote records snapshot event", async () => {
    const forgeStore = createMockForgeStore({
      origin: "primordial",
      policy: DEFAULT_UNSANDBOXED_POLICY,
    });
    const snapshotStore = createMockSnapshotStore();

    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        snapshotStore,
        windowSize: 3,
        quarantineThreshold: 0.9,
        clock: () => 100_000_000,
        demotionCriteria: {
          errorRateThreshold: 0.3,
          windowSize: 3,
          minSampleSize: 3,
          gracePeriodMs: 1000,
          demotionCooldownMs: 1000,
        },
      }),
    );

    tracker.recordFailure("forged-tool-1", 10, "e1");
    tracker.recordFailure("forged-tool-1", 10, "e2");
    tracker.recordSuccess("forged-tool-1", 10);

    await tracker.checkAndDemote("forged-tool-1");

    expect(snapshotStore.record).toHaveBeenCalledTimes(1);
    const snapshot = (snapshotStore.record.mock.calls[0] as unknown[])?.[0] as Record<
      string,
      unknown
    >;
    const event = snapshot.event as Record<string, unknown>;
    expect(event.kind).toBe("demoted");
    expect(event.fromTier).toBe("unsandboxed");
    expect(event.toTier).toBe("sandboxed");
  });

  test("checkAndDemote fires onDemotion callback", async () => {
    const forgeStore = createMockForgeStore({
      origin: "primordial",
      policy: DEFAULT_UNSANDBOXED_POLICY,
    });
    const snapshotStore = createMockSnapshotStore();
    const onDemotion = mock(() => {});

    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        snapshotStore,
        onDemotion,
        windowSize: 3,
        quarantineThreshold: 0.9,
        clock: () => 100_000_000,
        demotionCriteria: {
          errorRateThreshold: 0.3,
          windowSize: 3,
          minSampleSize: 3,
          gracePeriodMs: 1000,
          demotionCooldownMs: 1000,
        },
      }),
    );

    tracker.recordFailure("forged-tool-1", 10, "e1");
    tracker.recordFailure("forged-tool-1", 10, "e2");
    tracker.recordSuccess("forged-tool-1", 10);

    await tracker.checkAndDemote("forged-tool-1");

    expect(onDemotion).toHaveBeenCalledTimes(1);
    const event = (onDemotion.mock.calls[0] as unknown[])?.[0] as Record<string, unknown>;
    expect(event.from).toBe("unsandboxed");
    expect(event.to).toBe("sandboxed");
    expect(event.reason).toBe("error_rate");
  });

  test("checkAndDemote returns false when not warranted", async () => {
    const forgeStore = createMockForgeStore({
      origin: "primordial",
      policy: DEFAULT_UNSANDBOXED_POLICY,
    });

    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        windowSize: 5,
        quarantineThreshold: 0.9,
        clock: () => 100_000_000,
        demotionCriteria: {
          errorRateThreshold: 0.3,
          windowSize: 5,
          minSampleSize: 5,
          gracePeriodMs: 1000,
          demotionCooldownMs: 1000,
        },
      }),
    );

    // All successes — no demotion needed
    for (let i = 0; i < 5; i++) {
      tracker.recordSuccess("forged-tool-1", 10);
    }

    const result = await tracker.checkAndDemote("forged-tool-1");
    expect(result).toBe(false);
  });

  test("checkAndDemote returns false for unknown tool", async () => {
    const tracker = createToolHealthTracker(createTestConfig());
    const result = await tracker.checkAndDemote("unknown-tool");
    expect(result).toBe(false);
  });

  test("store errors throw with cause chaining", async () => {
    const forgeStore = createMockForgeStore({
      origin: "primordial",
      policy: DEFAULT_UNSANDBOXED_POLICY,
    });
    forgeStore.update = mock(() =>
      Promise.resolve({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "db down", retryable: false },
      }),
    );

    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        windowSize: 3,
        quarantineThreshold: 0.9,
        clock: () => 100_000_000,
        demotionCriteria: {
          errorRateThreshold: 0.3,
          windowSize: 3,
          minSampleSize: 3,
          gracePeriodMs: 1000,
          demotionCooldownMs: 1000,
        },
      }),
    );

    tracker.recordFailure("forged-tool-1", 10, "e1");
    tracker.recordFailure("forged-tool-1", 10, "e2");
    tracker.recordSuccess("forged-tool-1", 10);

    await expect(tracker.checkAndDemote("forged-tool-1")).rejects.toThrow(
      "Failed to update forge store",
    );
  });
});

// ---------------------------------------------------------------------------
// Fitness flush — cumulative counters + flush/dispose
// ---------------------------------------------------------------------------

describe("fitness flush", () => {
  test("cumulative counters increment through record calls", () => {
    const tracker = createToolHealthTracker(
      createTestConfig({ flushThreshold: 10, errorRateDeltaThreshold: 1 }),
    );
    tracker.recordSuccess("forged-tool-1", 50);
    tracker.recordSuccess("forged-tool-1", 60);
    tracker.recordFailure("forged-tool-1", 70, "err");

    // shouldFlushTool returns false with threshold=10 and errorRateDelta=1 after 3 calls
    expect(tracker.shouldFlushTool("forged-tool-1")).toBe(false);
  });

  test("shouldFlushTool returns true after reaching flush threshold", () => {
    const tracker = createToolHealthTracker(
      createTestConfig({ flushThreshold: 3, quarantineThreshold: 0.9 }),
    );
    tracker.recordSuccess("forged-tool-1", 10);
    tracker.recordSuccess("forged-tool-1", 10);
    expect(tracker.shouldFlushTool("forged-tool-1")).toBe(false);

    tracker.recordSuccess("forged-tool-1", 10);
    expect(tracker.shouldFlushTool("forged-tool-1")).toBe(true);
  });

  test("shouldFlushTool returns false for unknown tool", () => {
    const tracker = createToolHealthTracker(createTestConfig());
    expect(tracker.shouldFlushTool("unknown")).toBe(false);
  });

  test("flushTool writes fitness to ForgeStore", async () => {
    const forgeStore = createMockForgeStore();
    // Load returns a brick with default fitness
    forgeStore.load = mock(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          origin: "primordial",
          policy: DEFAULT_UNSANDBOXED_POLICY,
          lastPromotedAt: 0,
          lastDemotedAt: 0,
          fitness: {
            successCount: 0,
            errorCount: 0,
            latency: { samples: [], count: 0, cap: 200 },
            lastUsedAt: 0,
          },
        } as never,
      }),
    );

    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        flushThreshold: 3,
        quarantineThreshold: 0.9,
      }),
    );

    tracker.recordSuccess("forged-tool-1", 50);
    tracker.recordSuccess("forged-tool-1", 60);
    tracker.recordSuccess("forged-tool-1", 70);

    await tracker.flushTool("forged-tool-1");

    // Verify forgeStore.update was called with fitness
    expect(forgeStore.update).toHaveBeenCalledTimes(1);
    const updateArgs = forgeStore.update.mock.calls[0] as unknown[];
    const updates = updateArgs[1] as Record<string, unknown>;
    expect(updates.fitness).toBeDefined();
    const fitness = updates.fitness as Record<string, unknown>;
    expect(fitness.successCount).toBe(3);
    expect(fitness.errorCount).toBe(0);
    expect(updates.usageCount).toBe(3);
  });

  test("flushTool clears dirty flag on success", async () => {
    const forgeStore = createMockForgeStore();
    forgeStore.load = mock(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          origin: "primordial",
          policy: DEFAULT_UNSANDBOXED_POLICY,
          lastPromotedAt: 0,
          lastDemotedAt: 0,
          fitness: {
            successCount: 0,
            errorCount: 0,
            latency: { samples: [], count: 0, cap: 200 },
            lastUsedAt: 0,
          },
        } as never,
      }),
    );

    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        flushThreshold: 2,
        quarantineThreshold: 0.9,
      }),
    );

    tracker.recordSuccess("forged-tool-1", 50);
    tracker.recordSuccess("forged-tool-1", 60);
    expect(tracker.shouldFlushTool("forged-tool-1")).toBe(true);

    await tracker.flushTool("forged-tool-1");
    expect(tracker.shouldFlushTool("forged-tool-1")).toBe(false);
  });

  test("flushTool skips non-forged tools", async () => {
    const forgeStore = createMockForgeStore();
    const tracker = createToolHealthTracker(createTestConfig({ forgeStore, flushThreshold: 1 }));

    // "regular-tool" doesn't resolve to a brick ID
    tracker.recordSuccess("regular-tool", 50);
    await tracker.flushTool("regular-tool");

    // No store calls since resolveBrickId returns undefined
    expect(forgeStore.load).not.toHaveBeenCalled();
  });

  test("flushTool handles NOT_FOUND gracefully", async () => {
    const forgeStore = createMockForgeStore();
    forgeStore.load = mock(
      () =>
        Promise.resolve({
          ok: false as const,
          error: { code: "NOT_FOUND" as const, message: "deleted", retryable: false },
        }) as never,
    );
    const onFlushError = mock(() => {});

    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        flushThreshold: 2,
        quarantineThreshold: 0.9,
        onFlushError,
      }),
    );

    tracker.recordSuccess("forged-tool-1", 50);
    tracker.recordSuccess("forged-tool-1", 60);

    await tracker.flushTool("forged-tool-1");

    // onFlushError called with the NOT_FOUND error
    expect(onFlushError).toHaveBeenCalledTimes(1);
    // dirty should be cleared (brick no longer exists)
    expect(tracker.shouldFlushTool("forged-tool-1")).toBe(false);
  });

  test("flushTool handles update errors and keeps dirty", async () => {
    const forgeStore = createMockForgeStore();
    forgeStore.load = mock(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          origin: "primordial",
          policy: DEFAULT_UNSANDBOXED_POLICY,
          fitness: {
            successCount: 0,
            errorCount: 0,
            latency: { samples: [], count: 0, cap: 200 },
            lastUsedAt: 0,
          },
        } as never,
      }),
    );
    forgeStore.update = mock(
      () =>
        Promise.resolve({
          ok: false as const,
          error: { code: "INTERNAL" as const, message: "db error", retryable: true },
        }) as never,
    );
    const onFlushError = mock(() => {});

    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        flushThreshold: 2,
        quarantineThreshold: 0.9,
        onFlushError,
      }),
    );

    tracker.recordSuccess("forged-tool-1", 50);
    tracker.recordSuccess("forged-tool-1", 60);

    await tracker.flushTool("forged-tool-1");

    expect(onFlushError).toHaveBeenCalledTimes(1);
    // dirty should remain true so retry is possible
    expect(tracker.shouldFlushTool("forged-tool-1")).toBe(true);
  });

  test("concurrent flush is skipped (flushing flag)", async () => {
    const forgeStore = createMockForgeStore();
    // let: delay load to simulate slow store
    let resolveLoad: (() => void) | undefined;
    forgeStore.load = mock(
      () =>
        new Promise((resolve) => {
          resolveLoad = () =>
            resolve({
              ok: true as const,
              value: {
                origin: "primordial",
                policy: DEFAULT_UNSANDBOXED_POLICY,
                fitness: {
                  successCount: 0,
                  errorCount: 0,
                  latency: { samples: [], count: 0, cap: 200 },
                  lastUsedAt: 0,
                },
              } as never,
            });
        }),
    );

    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        flushThreshold: 2,
        quarantineThreshold: 0.9,
      }),
    );

    tracker.recordSuccess("forged-tool-1", 50);
    tracker.recordSuccess("forged-tool-1", 60);

    // Start first flush (will be pending)
    const flush1 = tracker.flushTool("forged-tool-1");

    // Second flush should skip because flushing flag is set
    await tracker.flushTool("forged-tool-1");

    // Resolve the first flush
    resolveLoad?.();
    await flush1;

    // Only one load call — second flush was skipped
    expect(forgeStore.load).toHaveBeenCalledTimes(1);
  });

  test("dispose flushes all dirty tools and clears state", async () => {
    const forgeStore = createMockForgeStore();
    forgeStore.load = mock(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          origin: "primordial",
          policy: DEFAULT_UNSANDBOXED_POLICY,
          fitness: {
            successCount: 0,
            errorCount: 0,
            latency: { samples: [], count: 0, cap: 200 },
            lastUsedAt: 0,
          },
        } as never,
      }),
    );

    const tracker = createToolHealthTracker(
      createTestConfig({
        forgeStore,
        flushThreshold: 100, // won't auto-flush
        quarantineThreshold: 0.9,
      }),
    );

    tracker.recordSuccess("forged-tool-1", 50);
    tracker.recordSuccess("forged-tool-2", 60);

    await tracker.dispose();

    // Both tools flushed
    expect(forgeStore.update).toHaveBeenCalledTimes(2);
    // State cleared — no snapshots remain
    expect(tracker.getAllSnapshots()).toHaveLength(0);
  });
});
