/**
 * Forge middleware pipeline E2E tests (Issue #1081).
 *
 * Tests the forge stack components wired together via createForgeMiddlewareStack:
 * - Demand detection → auto-forge → brick creation
 * - Optimizer session-end sweep → brick evaluation
 * - Forge event bridge → dashboard event batching
 * - Full middleware stack wiring
 *
 * All tests are deterministic — no real LLM calls. Uses NexusForgeStore
 * with createFakeNexusFetch to exercise the real Nexus JSON-RPC parsing path.
 *
 * Run:
 *   bun test tests/e2e/forge-pipeline-e2e.test.ts
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  BrickArtifact,
  ForgeDemandSignal,
  ForgeStore,
  SnapshotStore,
  ToolArtifact,
  TurnTrace,
} from "@koi/core";
import {
  brickId,
  DEFAULT_FORGE_BUDGET,
  DEFAULT_SANDBOXED_POLICY,
  DEFAULT_UNSANDBOXED_POLICY,
  sessionId,
} from "@koi/core";
import type { AutoForgeDemandHandle } from "@koi/crystallize/auto-forge";
import {
  type CrystallizationCandidate,
  type CrystallizeHandle,
  createAutoForgeMiddleware,
  createCrystallizeMiddleware,
  createDefaultForgeConfig,
  createForgeEventBridge,
  createForgeMiddlewareStack,
} from "@koi/forge";
import { createOptimizerMiddleware } from "@koi/forge-optimizer";
import { createToolHealthTracker } from "@koi/middleware-feedback-loop";
import { createNexusForgeStore } from "@koi/nexus-store/forge";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { createFakeNexusFetch } from "@koi/test-utils-mocks";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function createStore(): ForgeStore {
  return createNexusForgeStore({
    baseUrl: "http://fake-nexus",
    apiKey: "test-key",
    fetch: createFakeNexusFetch(),
  });
}

function noopSnapshotStore(): SnapshotStore {
  return {
    record: async () => ({ ok: true as const, value: undefined }),
    get: async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "noop", retryable: false },
    }),
    list: async () => ({ ok: true as const, value: [] }),
    history: async () => ({ ok: true as const, value: [] }),
    latest: async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "noop", retryable: false },
    }),
  };
}

/** Build a TurnTrace with tool_call events for crystallize pattern detection. */
function createTrace(turnIndex: number, toolIds: readonly string[]): TurnTrace {
  return {
    turnIndex,
    sessionId: sessionId("test-session"),
    agentId: "test-agent",
    events: toolIds.map((toolId, i) => ({
      eventIndex: i,
      turnIndex,
      event: {
        kind: "tool_call" as const,
        toolId,
        callId: `call-${String(turnIndex)}-${String(i)}` as import("@koi/core").ToolCallId,
        input: {},
        output: {},
        durationMs: 10,
      },
      timestamp: NOW + turnIndex * 1000 + i,
    })),
    durationMs: toolIds.length * 10,
  };
}

function createMockCrystallizeHandle(): CrystallizeHandle {
  return {
    middleware: { name: "crystallize", describeCapabilities: () => undefined },
    getCandidates: () => [],
    dismiss: mock(() => {}),
  };
}

function createMockTurnContext(turnIndex = 0): { readonly turnIndex: number } {
  return { turnIndex } as { readonly turnIndex: number };
}

async function flush(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 1. Demand → forge pipeline
// ---------------------------------------------------------------------------

describe("e2e: demand detection → auto-forge pipeline", () => {
  test("repeated_failure demand signal creates pioneer brick in store", async () => {
    const store = createStore();
    const handle = createMockCrystallizeHandle();

    const signal: ForgeDemandSignal = {
      id: "demand-rf-1",
      kind: "forge_demand",
      trigger: { kind: "repeated_failure", toolName: "exec", count: 3 },
      confidence: 0.95,
      suggestedBrickKind: "tool",
      context: { failureCount: 3, failedToolCalls: ["exec", "exec", "exec"] },
      emittedAt: NOW,
    };

    const demandHandle: AutoForgeDemandHandle = {
      getSignals: () => [signal],
      dismiss: mock(() => {}),
    };

    const onDemandForged = mock((_s: ForgeDemandSignal, _b: BrickArtifact) => {});

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5, maxForgesPerSession: 5 },
      clock: () => NOW,
      onDemandForged,
    });

    await mw.onSessionStart?.({} as never);
    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    // Brick created and callback fired
    expect(onDemandForged).toHaveBeenCalledTimes(1);

    // Verify brick is in store with correct properties
    const result = await store.search({ lifecycle: "active", kind: "tool" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pioneer = result.value.find((b) => b.name === "pioneer-exec");
    expect(pioneer).toBeDefined();
    // Demand-forged pioneers use origin: "primordial" (placeholder for future harness synthesis)
    expect(pioneer?.origin).toBe("primordial");
    expect(pioneer?.policy.sandbox).toBe(true); // demand-forged starts sandboxed
    expect(pioneer?.tags).toContain("demand-forged");
    expect(pioneer?.tags).toContain("pioneer");
  });

  test("capability_gap demand signal creates pioneer brick", async () => {
    const store = createStore();
    const handle = createMockCrystallizeHandle();

    const signal: ForgeDemandSignal = {
      id: "demand-cg-1",
      kind: "forge_demand",
      trigger: { kind: "capability_gap", requiredCapability: "image generation" },
      confidence: 0.85,
      suggestedBrickKind: "tool",
      context: { failureCount: 0, failedToolCalls: [] },
      emittedAt: NOW,
    };

    const demandHandle: AutoForgeDemandHandle = {
      getSignals: () => [signal],
      dismiss: mock(() => {}),
    };

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5, maxForgesPerSession: 5 },
      clock: () => NOW,
    });

    await mw.onSessionStart?.({} as never);
    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    const result = await store.search({ lifecycle: "active", kind: "tool" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pioneer = result.value.find((b) => b.name === "pioneer-image generation");
    expect(pioneer).toBeDefined();
  });

  test("budget enforcement limits forges within single session", async () => {
    const store = createStore();
    const handle = createMockCrystallizeHandle();
    const forgeCount = { value: 0 }; // let justified: test accumulator

    // 5 different tool names as signals in one batch
    const signals: ForgeDemandSignal[] = Array.from({ length: 5 }, (_, i) => ({
      id: `demand-${String(i)}`,
      kind: "forge_demand" as const,
      trigger: { kind: "repeated_failure" as const, toolName: `tool-${String(i)}`, count: 3 },
      confidence: 0.95,
      suggestedBrickKind: "tool" as const,
      context: { failureCount: 3, failedToolCalls: [`tool-${String(i)}`] },
      emittedAt: NOW + i * 1000,
    }));

    const demandHandle: AutoForgeDemandHandle = {
      getSignals: () => signals,
      dismiss: mock(() => {}),
    };

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5, maxForgesPerSession: 2 },
      clock: () => NOW,
      onDemandForged: () => {
        forgeCount.value++;
      },
    });

    await mw.onSessionStart?.({} as never);
    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    // Budget=2 enforced within the session: only 2 of 5 signals processed
    // (fire-and-forget race means both may save, but counter prevents more than 2 dispatches)
    expect(forgeCount.value).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Optimizer session-end sweep
// ---------------------------------------------------------------------------

describe("e2e: optimizer session-end sweep", () => {
  test("brick with insufficient data is skipped on sweep", async () => {
    const store = createStore();

    // Seed brick with only 2 uses (below minSampleSize of 20)
    const brick: ToolArtifact = {
      id: brickId("brick_low-sample"),
      kind: "tool",
      name: "low-sample-tool",
      description: "A tool with too few invocations",
      scope: "agent",
      origin: "forged",
      policy: DEFAULT_SANDBOXED_POLICY,
      lifecycle: "active",
      provenance: {
        ...DEFAULT_PROVENANCE,
        source: { origin: "forged", forgedBy: "auto-forge-middleware", sessionId: "s1" },
        buildDefinition: {
          buildType: "koi.crystallize/composite/v1",
          externalParameters: { ngramKey: "a|b", occurrences: 3, score: 0.8 },
        },
      },
      version: "0.1.0",
      tags: ["crystallized", "auto-forged"],
      usageCount: 2,
      fitness: {
        successCount: 1,
        errorCount: 1,
        latency: { samples: [100, 200], count: 2, cap: 100 },
        lastUsedAt: NOW - 500,
      },
      implementation: "return 1;",
      inputSchema: { type: "object" },
    };
    await store.save(brick);

    const optimizer = createOptimizerMiddleware({
      store,
      minSampleSize: 20, // brick has only 2 → insufficient
      clock: () => NOW,
    });

    await optimizer.onSessionEnd?.({} as never);

    // Brick should still be active (insufficient data → skipped)
    const result = await store.load(brick.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lifecycle).toBe("active");
  });

  test("optimizer sweep runs without errors on empty store", async () => {
    const store = createStore();
    const sweepResults: unknown[] = []; // let justified: test accumulator

    const optimizer = createOptimizerMiddleware({
      store,
      clock: () => NOW,
      onSweepComplete: (results) => {
        sweepResults.push(...results);
      },
    });

    // Should not throw on empty store
    await optimizer.onSessionEnd?.({} as never);
    expect(sweepResults).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Forge event bridge batching
// ---------------------------------------------------------------------------

describe("e2e: forge event bridge", () => {
  test("batches multiple events emitted in same tick", async () => {
    type EventBatch = readonly { readonly kind: string; readonly subKind: string }[];
    const batches: EventBatch[] = []; // let justified: test accumulator

    const bridge = createForgeEventBridge({
      onDashboardEvent: (events) => {
        batches.push(events as unknown as EventBatch);
      },
      clock: () => NOW,
    });

    // Emit multiple events synchronously
    bridge.onQuarantine("brick-1");
    bridge.onFitnessFlush("brick-2", 0.85, 50);

    // Before microtask flush — no batches yet
    expect(batches).toHaveLength(0);

    // Wait for microtask to flush
    await flush(10);

    // All events batched into a single delivery
    expect(batches).toHaveLength(1);
    expect(batches[0]?.length).toBe(2);
  });

  test("emits demand_detected event via subKind", async () => {
    type Event = { readonly kind: string; readonly subKind: string };
    const events: Event[] = []; // let justified: test accumulator

    const bridge = createForgeEventBridge({
      onDashboardEvent: (batch) => {
        events.push(...(batch as unknown as Event[]));
      },
      clock: () => NOW,
    });

    const signal: ForgeDemandSignal = {
      id: "demand-1",
      kind: "forge_demand",
      trigger: { kind: "repeated_failure", toolName: "exec", count: 3 },
      confidence: 0.9,
      suggestedBrickKind: "tool",
      context: { failureCount: 3, failedToolCalls: ["exec"] },
      emittedAt: NOW,
    };

    bridge.onDemand(signal);
    await flush(10);

    const demandEvents = events.filter((e) => e.subKind === "demand_detected");
    expect(demandEvents).toHaveLength(1);
  });

  test("emits brick_quarantined event via subKind", async () => {
    type Event = { readonly kind: string; readonly subKind: string };
    const events: Event[] = []; // let justified: test accumulator

    const bridge = createForgeEventBridge({
      onDashboardEvent: (batch) => {
        events.push(...(batch as unknown as Event[]));
      },
      clock: () => NOW,
    });

    bridge.onQuarantine("brick-quarantined-1");
    await flush(10);

    const quarantineEvents = events.filter((e) => e.subKind === "brick_quarantined");
    expect(quarantineEvents).toHaveLength(1);
  });

  test("emits fitness_flushed event via subKind", async () => {
    type Event = { readonly kind: string; readonly subKind: string };
    const events: Event[] = []; // let justified: test accumulator

    const bridge = createForgeEventBridge({
      onDashboardEvent: (batch) => {
        events.push(...(batch as unknown as Event[]));
      },
      clock: () => NOW,
    });

    bridge.onFitnessFlush("brick-fit-1", 0.92, 100);
    await flush(10);

    const fitnessEvents = events.filter((e) => e.subKind === "fitness_flushed");
    expect(fitnessEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Full middleware stack wiring
// ---------------------------------------------------------------------------

describe("e2e: full forge middleware stack", () => {
  test("createForgeMiddlewareStack returns all middleware components", () => {
    const store = createStore();
    const result = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: () => Promise.resolve({ ok: true, value: [] }),
      resolveBrickId: () => undefined,
    });

    // Should return 7 base middlewares
    expect(result.middlewares.length).toBeGreaterThanOrEqual(7);

    // Verify handles are provided
    expect(result.handles.demand).toBeDefined();
    expect(result.handles.crystallize).toBeDefined();
    expect(result.handles.feedbackLoop).toBeDefined();
  });

  test("middleware stack with snapshotStore and event bridge", () => {
    const store = createStore();

    const result = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: () => Promise.resolve({ ok: true, value: [] }),
      resolveBrickId: () => undefined,
      snapshotStore: noopSnapshotStore(),
      onDashboardEvent: () => {},
    });

    // Verify stack created successfully with optional components
    expect(result.middlewares.length).toBeGreaterThanOrEqual(7);
  });

  test("demand handle starts with no signals", () => {
    const store = createStore();
    const result = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: () => Promise.resolve({ ok: true, value: [] }),
      resolveBrickId: () => undefined,
    });

    expect(result.handles.demand.getSignals()).toHaveLength(0);
    expect(result.handles.demand.getActiveSignalCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Crystallize middleware — pattern detection from TurnTrace
// ---------------------------------------------------------------------------

describe("e2e: crystallize middleware pattern detection", () => {
  test("detects repeated 2-tool sequence from turn traces", async () => {
    // Build traces where ["fetch", "parse"] repeats 5 times across turns
    const traces: TurnTrace[] = [];
    for (let t = 0; t < 5; t++) {
      traces.push(createTrace(t, ["fetch", "parse"]));
    }

    const candidates: CrystallizationCandidate[] = []; // let justified: test accumulator

    const handle = createCrystallizeMiddleware({
      readTraces: () => Promise.resolve({ ok: true, value: traces }),
      minNgramSize: 2,
      maxNgramSize: 3,
      minOccurrences: 3,
      minTurnsBeforeAnalysis: 1,
      clock: () => NOW,
      onCandidatesDetected: (detected) => {
        candidates.push(...detected);
      },
    });

    // Run after-turn to trigger pattern detection
    await handle.middleware.onAfterTurn?.({ turnIndex: 5 } as never);

    // Should detect fetch|parse as a repeating pattern
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const fetchParse = candidates.find((c) => c.ngram.key === "fetch|parse");
    expect(fetchParse).toBeDefined();
    expect(fetchParse?.occurrences).toBeGreaterThanOrEqual(3);
  });

  test("does not detect patterns below occurrence threshold", async () => {
    // Only 2 occurrences — below threshold of 3
    const traces: TurnTrace[] = [
      createTrace(0, ["fetch", "parse"]),
      createTrace(1, ["fetch", "parse"]),
    ];

    const candidates: CrystallizationCandidate[] = []; // let justified: test accumulator

    const handle = createCrystallizeMiddleware({
      readTraces: () => Promise.resolve({ ok: true, value: traces }),
      minNgramSize: 2,
      maxNgramSize: 3,
      minOccurrences: 3,
      minTurnsBeforeAnalysis: 1,
      clock: () => NOW,
      onCandidatesDetected: (detected) => {
        candidates.push(...detected);
      },
    });

    await handle.middleware.onAfterTurn?.({ turnIndex: 2 } as never);

    // No candidates — below threshold
    expect(candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Trust demotion via ToolHealthTracker
// ---------------------------------------------------------------------------

describe("e2e: trust demotion", () => {
  test("sustained failures demote forged brick to sandbox trust", async () => {
    const store = createStore();

    // Seed an unsandboxed (promoted) forged brick
    const brick: ToolArtifact = {
      id: brickId("brick_promoted-tool"),
      kind: "tool",
      name: "promoted-tool",
      description: "A promoted tool with elevated trust",
      scope: "agent",
      origin: "primordial",
      policy: DEFAULT_UNSANDBOXED_POLICY,
      lifecycle: "active",
      provenance: DEFAULT_PROVENANCE,
      version: "0.1.0",
      tags: ["demand-forged"],
      usageCount: 100,
      implementation: "return input;",
      inputSchema: { type: "object" },
    };
    await store.save(brick);

    const demotionEvents: Array<{ readonly brickId: string }> = []; // let justified: test accumulator

    const tracker = createToolHealthTracker({
      forgeStore: store,
      snapshotStore: noopSnapshotStore(),
      resolveBrickId: (toolId) => (toolId === "promoted-tool" ? "brick_promoted-tool" : undefined),
      clock: () => NOW,
      windowSize: 5,
      demotionCriteria: {
        errorRateThreshold: 0.3,
        windowSize: 5,
        minSampleSize: 3,
        gracePeriodMs: 0, // no grace for test
        demotionCooldownMs: 0, // no cooldown for test
      },
      onDemotion: (event) => {
        demotionEvents.push({ brickId: event.brickId });
      },
    });

    // Record 1 success + 4 failures → 80% error rate (above 30% threshold)
    tracker.recordSuccess("promoted-tool", 50);
    tracker.recordFailure("promoted-tool", 100, "timeout");
    tracker.recordFailure("promoted-tool", 100, "connection refused");
    tracker.recordFailure("promoted-tool", 100, "500 error");
    tracker.recordFailure("promoted-tool", 100, "timeout again");

    // Trigger demotion check
    const demoted = await tracker.checkAndDemote("promoted-tool");
    expect(demoted).toBe(true);

    // Verify demotion callback was fired
    expect(demotionEvents).toHaveLength(1);
    expect(demotionEvents[0]?.brickId).toBe("brick_promoted-tool");

    // Verify brick policy was changed to sandbox in store
    const result = await store.load(brick.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.policy.sandbox).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Quarantine via ToolHealthTracker
// ---------------------------------------------------------------------------

describe("e2e: quarantine", () => {
  test("error rate above threshold quarantines forged brick", async () => {
    const store = createStore();

    // Seed an active forged brick
    const brick: ToolArtifact = {
      id: brickId("brick_flaky-tool"),
      kind: "tool",
      name: "flaky-tool",
      description: "A flaky tool that will be quarantined",
      scope: "agent",
      origin: "primordial",
      policy: DEFAULT_SANDBOXED_POLICY,
      lifecycle: "active",
      provenance: DEFAULT_PROVENANCE,
      version: "0.1.0",
      tags: ["demand-forged"],
      usageCount: 20,
      implementation: "throw new Error('broken');",
      inputSchema: { type: "object" },
    };
    await store.save(brick);

    const quarantineEvents: string[] = []; // let justified: test accumulator

    const tracker = createToolHealthTracker({
      forgeStore: store,
      snapshotStore: noopSnapshotStore(),
      resolveBrickId: (toolId) => (toolId === "flaky-tool" ? "brick_flaky-tool" : undefined),
      clock: () => NOW,
      windowSize: 10,
      quarantineThreshold: 0.5, // quarantine at ≥50% error rate
      onQuarantine: (qBrickId) => {
        quarantineEvents.push(qBrickId);
      },
    });

    // Record 8 failures + 2 successes → 80% error rate (above 50% threshold)
    for (let i = 0; i < 8; i++) {
      tracker.recordFailure("flaky-tool", 100, `error-${String(i)}`);
    }
    tracker.recordSuccess("flaky-tool", 50);
    tracker.recordSuccess("flaky-tool", 50);

    // Trigger quarantine check
    const quarantined = await tracker.checkAndQuarantine("flaky-tool");
    expect(quarantined).toBe(true);

    // Verify quarantine callback fired
    expect(quarantineEvents).toHaveLength(1);
    expect(quarantineEvents[0]).toBe("brick_flaky-tool");

    // Verify brick lifecycle changed to "failed" in store
    const result = await store.load(brick.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lifecycle).toBe("failed");

    // Verify tool is marked as quarantined in tracker
    expect(tracker.isQuarantined("flaky-tool")).toBe(true);
  });

  test("healthy tool is NOT quarantined", async () => {
    const store = createStore();

    const brick: ToolArtifact = {
      id: brickId("brick_healthy-tool"),
      kind: "tool",
      name: "healthy-tool",
      description: "A healthy tool",
      scope: "agent",
      origin: "primordial",
      policy: DEFAULT_SANDBOXED_POLICY,
      lifecycle: "active",
      provenance: DEFAULT_PROVENANCE,
      version: "0.1.0",
      tags: [],
      usageCount: 50,
      implementation: "return input;",
      inputSchema: { type: "object" },
    };
    await store.save(brick);

    const tracker = createToolHealthTracker({
      forgeStore: store,
      snapshotStore: noopSnapshotStore(),
      resolveBrickId: (toolId) => (toolId === "healthy-tool" ? "brick_healthy-tool" : undefined),
      clock: () => NOW,
      windowSize: 10,
      quarantineThreshold: 0.5,
    });

    // Record 9 successes + 1 failure → 10% error rate (below 50%)
    for (let i = 0; i < 9; i++) {
      tracker.recordSuccess("healthy-tool", 50);
    }
    tracker.recordFailure("healthy-tool", 100, "rare-error");

    const quarantined = await tracker.checkAndQuarantine("healthy-tool");
    expect(quarantined).toBe(false);
    expect(tracker.isQuarantined("healthy-tool")).toBe(false);

    // Brick still active
    const result = await store.load(brick.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lifecycle).toBe("active");
  });
});
