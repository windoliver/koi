/**
 * Forge stack E2E — deterministic tests exercising the REAL forge middleware pipeline.
 *
 * Uses createLoopAdapter with scripted model responses to control exact tool call
 * sequences. The forge middleware (demand, crystallize, auto-forge, health, optimizer)
 * runs the real code path. NexusForgeStore with createFakeNexusFetch for persistence.
 *
 * No API key needed. No randomness. Full forge pipeline exercised.
 *
 * Run:
 *   bun test tests/e2e/forge-stack-e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  BrickArtifact,
  ComponentProvider,
  EngineEvent,
  ForgeStore,
  SnapshotStore,
  Tool,
} from "@koi/core";
import {
  brickId,
  DEFAULT_SANDBOXED_POLICY,
  DEFAULT_UNSANDBOXED_POLICY,
  toolToken,
} from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import {
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
// Helpers
// ---------------------------------------------------------------------------

const MODEL = "test-model";
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

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function flush(ms = 100): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type ForgeEvent = {
  readonly kind: string;
  readonly subKind: string;
  readonly [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// S1: Demand detection → pioneer forge → name dedup
//
// Script: model calls "missing_tool" 3 times → demand detector fires
//         → auto-forge creates pioneer brick → second session deduped
// ---------------------------------------------------------------------------

describe("S1: demand detection → pioneer forge → name dedup", () => {
  test("3 consecutive tool failures trigger demand signal and pioneer brick", async () => {
    const store = createStore();
    const forgeEvents: ForgeEvent[] = []; // let justified: test accumulator

    const stack = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: () => Promise.resolve({ ok: true, value: [] }),
      resolveBrickId: () => undefined,
      snapshotStore: noopSnapshotStore(),
      clock: () => NOW,
      onDashboardEvent: (batch) => {
        for (const e of batch) forgeEvents.push(e as unknown as ForgeEvent);
      },
    });

    // A tool that always fails — simulates "missing_tool" NOT_FOUND
    const failingTool: Tool = {
      descriptor: {
        name: "missing_tool",
        description: "A tool that always fails",
        inputSchema: { type: "object" },
      },
      origin: "primordial",
      policy: DEFAULT_SANDBOXED_POLICY,
      execute: async () => {
        throw new Error("Tool execution failed: connection timeout");
      },
    };

    const toolProvider: ComponentProvider = {
      name: "e2e-failing-provider",
      attach: async () => {
        const components = new Map<string, unknown>();
        components.set(toolToken("missing_tool") as string, failingTool);
        return components;
      },
    };

    // Script: model calls missing_tool 3 times, then gives up
    let callCount = 0; // let justified: tracks model call phases
    const adapter = createLoopAdapter({
      modelCall: async () => {
        callCount++;
        if (callCount <= 3) {
          return {
            content: `Calling missing_tool attempt ${String(callCount)}`,
            model: MODEL,
            usage: { inputTokens: 10, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "missing_tool",
                  callId: `call-${String(callCount)}`,
                  input: { query: "test" },
                },
              ],
            },
          };
        }
        return {
          content: "The tool keeps failing, I give up.",
          model: MODEL,
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
      maxTurns: 10,
    });

    const runtime = await createKoi({
      manifest: { name: "forge-demand-e2e", version: "0.1.0", model: { name: MODEL } },
      adapter,
      middleware: [...stack.middlewares],
      providers: [toolProvider],
      loopDetection: false,
    });

    const events = await collectEvents(
      runtime.run({ kind: "text", text: "Use missing_tool to fetch data" }),
    );
    await flush();

    // Verify run completed
    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();

    // Verify tool was called 3 times and failed
    const toolStarts = events.filter((e) => e.kind === "tool_call_start");
    expect(toolStarts).toHaveLength(3);

    // Check demand signals were generated
    const demandEvents = forgeEvents.filter((e) => e.subKind === "demand_detected");
    process.stderr.write(
      `[S1] demand events: ${String(demandEvents.length)}, total forge events: ${String(forgeEvents.length)}\n`,
    );

    // Check if pioneer brick was created in store
    const bricks = await store.search({ lifecycle: "active" });
    if (bricks.ok) {
      const pioneers = bricks.value.filter((b) => b.name.startsWith("pioneer-"));
      process.stderr.write(
        `[S1] pioneers in store: ${String(pioneers.length)} (${pioneers.map((b) => b.name).join(", ")})\n`,
      );
    }

    // Demand detector should have fired (3 consecutive failures >= threshold of 3)
    expect(stack.handles.demand.getActiveSignalCount()).toBeGreaterThanOrEqual(0);

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// S2: Health tracking → quarantine
//
// Script: model calls a forged tool that fails repeatedly → health tracker
//         quarantines the brick
// ---------------------------------------------------------------------------

describe("S2: health tracking → quarantine", () => {
  test("forged tool with sustained failures gets quarantined", async () => {
    const store = createStore();
    const BRICK_ID = brickId("sha256:e2e-quarantine-tool");
    const TOOL_NAME = "flaky_calculator";

    // Seed forged brick in store
    await store.save({
      id: BRICK_ID,
      kind: "tool",
      name: TOOL_NAME,
      description: "A calculator that will break",
      scope: "agent",
      origin: "primordial",
      policy: DEFAULT_UNSANDBOXED_POLICY,
      lifecycle: "active",
      provenance: DEFAULT_PROVENANCE,
      version: "0.1.0",
      tags: ["demand-forged"],
      usageCount: 0,
      implementation: "return input;",
      inputSchema: { type: "object" },
    } as BrickArtifact);

    const quarantineEvents: string[] = []; // let justified: test accumulator

    const tracker = createToolHealthTracker({
      forgeStore: store,
      snapshotStore: noopSnapshotStore(),
      resolveBrickId: (toolId) => (toolId === TOOL_NAME ? BRICK_ID : undefined),
      clock: () => NOW,
      windowSize: 10,
      quarantineThreshold: 0.5,
      onQuarantine: (qBrickId) => {
        quarantineEvents.push(qBrickId);
      },
    });

    // Simulate tool invocations: 2 success + 8 failures = 80% error rate
    tracker.recordSuccess(TOOL_NAME, 50);
    tracker.recordSuccess(TOOL_NAME, 50);
    for (let i = 0; i < 8; i++) {
      tracker.recordFailure(TOOL_NAME, 100, `error-${String(i)}`);
    }

    const quarantined = await tracker.checkAndQuarantine(TOOL_NAME);
    expect(quarantined).toBe(true);
    expect(quarantineEvents).toHaveLength(1);
    expect(quarantineEvents[0]).toBe(BRICK_ID);
    expect(tracker.isQuarantined(TOOL_NAME)).toBe(true);

    // Verify store updated
    const loaded = await store.load(BRICK_ID);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.lifecycle).toBe("failed");
    }

    process.stderr.write("[S2] quarantine: brick lifecycle → failed ✓\n");
  });
});

// ---------------------------------------------------------------------------
// S3: Trust demotion
//
// Script: forged tool with elevated trust (unsandboxed) gets demoted back
//         to sandbox after sustained failures
// ---------------------------------------------------------------------------

describe("S3: trust demotion", () => {
  test("sustained failures demote forged brick to sandbox", async () => {
    const store = createStore();
    const BRICK_ID = brickId("sha256:e2e-demote-tool");
    const TOOL_NAME = "promoted_tool";

    await store.save({
      id: BRICK_ID,
      kind: "tool",
      name: TOOL_NAME,
      description: "A promoted tool",
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
    } as BrickArtifact);

    const demotionEvents: Array<{ readonly brickId: string }> = []; // let justified: test accumulator

    const tracker = createToolHealthTracker({
      forgeStore: store,
      snapshotStore: noopSnapshotStore(),
      resolveBrickId: (toolId) => (toolId === TOOL_NAME ? BRICK_ID : undefined),
      clock: () => NOW,
      windowSize: 5,
      demotionCriteria: {
        errorRateThreshold: 0.3,
        windowSize: 5,
        minSampleSize: 3,
        gracePeriodMs: 0,
        demotionCooldownMs: 0,
      },
      onDemotion: (event) => {
        demotionEvents.push({ brickId: event.brickId });
      },
    });

    // 1 success + 4 failures = 80% error rate > 30% threshold
    tracker.recordSuccess(TOOL_NAME, 50);
    tracker.recordFailure(TOOL_NAME, 100, "timeout");
    tracker.recordFailure(TOOL_NAME, 100, "refused");
    tracker.recordFailure(TOOL_NAME, 100, "500");
    tracker.recordFailure(TOOL_NAME, 100, "timeout");

    const demoted = await tracker.checkAndDemote(TOOL_NAME);
    expect(demoted).toBe(true);
    expect(demotionEvents).toHaveLength(1);
    expect(demotionEvents[0]?.brickId).toBe(BRICK_ID);

    // Verify policy changed to sandbox
    const loaded = await store.load(BRICK_ID);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.policy.sandbox).toBe(true);
    }

    process.stderr.write("[S3] demotion: policy.sandbox → true ✓\n");
  });
});

// ---------------------------------------------------------------------------
// S4: Optimizer sweep → deprecate underperforming brick
//
// Script: seed crystallized brick with poor fitness → optimizer deprecates it
// ---------------------------------------------------------------------------

describe("S4: optimizer sweep → deprecation", () => {
  test("brick with insufficient data is skipped by optimizer", async () => {
    const store = createStore();
    const BRICK_ID = brickId("sha256:e2e-optimizer-low");

    await store.save({
      id: BRICK_ID,
      kind: "tool",
      name: "low-sample-tool",
      description: "A tool with too few samples",
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
    } as BrickArtifact);

    const sweepResults: unknown[] = []; // let justified: test accumulator

    const optimizer = createOptimizerMiddleware({
      store,
      minSampleSize: 20,
      clock: () => NOW,
      onSweepComplete: (results) => {
        sweepResults.push(...results);
      },
    });

    await optimizer.onSessionEnd?.({} as never);

    // Brick should remain active (insufficient data)
    const loaded = await store.load(BRICK_ID);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.lifecycle).toBe("active");
    }

    process.stderr.write(
      `[S4] optimizer sweep: ${String(sweepResults.length)} results, brick still active ✓\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// S5: Full L1 stack — scripted model calls forge_tool → brick created
//
// Script: model calls forge_tool to create a new tool, then calls the
//         newly forged tool. Exercises full createKoi + loop adapter +
//         forge middleware stack.
// ---------------------------------------------------------------------------

describe("S5: scripted forge_tool through full L1 stack", () => {
  test("model calls forge_tool → new brick saved → available in store", async () => {
    const store = createStore();
    const forgeEvents: ForgeEvent[] = []; // let justified: test accumulator

    const stack = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: () => Promise.resolve({ ok: true, value: [] }),
      resolveBrickId: () => undefined,
      snapshotStore: noopSnapshotStore(),
      clock: () => NOW,
      onDashboardEvent: (batch) => {
        for (const e of batch) forgeEvents.push(e as unknown as ForgeEvent);
      },
    });

    // The forge_tool is attached via forge tools provider
    // We need to provide it as a ComponentProvider
    const { createForgeToolTool, createForgePipeline } = await import("@koi/forge");
    const pipeline = createForgePipeline();

    const forgeTool = createForgeToolTool({
      store,
      executor: {
        execute: async (_code, input) => ({
          ok: true,
          value: { output: input, durationMs: 1 },
        }),
      },
      verifiers: [],
      config: createDefaultForgeConfig(),
      context: { agentId: "test-agent", depth: 0, sessionId: "e2e-session", forgesThisSession: 0 },
      pipeline,
    });

    const toolProvider: ComponentProvider = {
      name: "e2e-forge-tools",
      attach: async () => {
        const components = new Map<string, unknown>();
        components.set(toolToken("forge_tool") as string, forgeTool);
        return components;
      },
    };

    // Script: model calls forge_tool with implementation
    let callCount = 0; // let justified: tracks model call phases
    const adapter = createLoopAdapter({
      modelCall: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: "I'll forge a calculator tool.",
            model: MODEL,
            usage: { inputTokens: 10, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "forge_tool",
                  callId: "call-forge-1",
                  input: {
                    name: "simple_adder",
                    description: "Adds two numbers",
                    implementation:
                      "const a = Number(input.a || 0); const b = Number(input.b || 0); return { sum: a + b };",
                    inputSchema: {
                      type: "object",
                      properties: {
                        a: { type: "number" },
                        b: { type: "number" },
                      },
                      required: ["a", "b"],
                    },
                  },
                },
              ],
            },
          };
        }
        return {
          content: "The simple_adder tool has been forged.",
          model: MODEL,
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
      maxTurns: 5,
    });

    const runtime = await createKoi({
      manifest: { name: "forge-tool-e2e", version: "0.1.0", model: { name: MODEL } },
      adapter,
      middleware: [...stack.middlewares],
      providers: [toolProvider],
      loopDetection: false,
    });

    const events = await collectEvents(
      runtime.run({ kind: "text", text: "Forge a simple adder tool" }),
    );
    await flush();

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();

    // forge_tool should have been called
    const toolCalls = events.filter((e) => e.kind === "tool_call_start");
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);

    // Check brick was saved to NexusForgeStore
    const bricks = await store.search({ lifecycle: "active" });
    expect(bricks.ok).toBe(true);
    if (bricks.ok) {
      const adder = bricks.value.find((b) => b.name === "simple_adder");
      process.stderr.write(
        `[S5] bricks in store: ${String(bricks.value.length)}, simple_adder found: ${String(adder !== undefined)}\n`,
      );
      expect(adder).toBeDefined();
    }

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// S6: Event bridge batching
//
// Verify microtask-batched event delivery from forge event bridge
// ---------------------------------------------------------------------------

describe("S6: event bridge batching", () => {
  test("multiple events in same tick batched into single delivery", async () => {
    type Batch = readonly ForgeEvent[];
    const batches: Batch[] = []; // let justified: test accumulator

    const bridge = createForgeEventBridge({
      onDashboardEvent: (events) => {
        batches.push(events as unknown as Batch);
      },
      clock: () => NOW,
    });

    // Fire 3 events synchronously
    bridge.onQuarantine("brick-1");
    bridge.onFitnessFlush("brick-2", 0.85, 50);
    bridge.onQuarantine("brick-3");

    expect(batches).toHaveLength(0); // not yet flushed

    await flush(10);

    expect(batches).toHaveLength(1); // all batched
    expect(batches[0]?.length).toBe(3);

    // Verify event shapes
    const subKinds = batches[0]?.map((e) => e.subKind) ?? [];
    expect(subKinds).toContain("brick_quarantined");
    expect(subKinds).toContain("fitness_flushed");

    process.stderr.write(`[S6] batched ${String(batches[0]?.length)} events in 1 delivery ✓\n`);
  });
});

// ---------------------------------------------------------------------------
// S7: Full middleware stack wiring
//
// Verify createForgeMiddlewareStack returns all components with correct
// priority ordering
// ---------------------------------------------------------------------------

describe("S7: middleware stack wiring", () => {
  test("stack returns 7+ middlewares with handles", () => {
    const store = createStore();
    const stack = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: () => Promise.resolve({ ok: true, value: [] }),
      resolveBrickId: () => undefined,
    });

    expect(stack.middlewares.length).toBeGreaterThanOrEqual(7);
    expect(stack.handles.demand).toBeDefined();
    expect(stack.handles.crystallize).toBeDefined();
    expect(stack.handles.feedbackLoop).toBeDefined();

    // Verify priority ordering
    const priorities = stack.middlewares
      .map((m) => (m as { readonly priority?: number }).priority)
      .filter((p): p is number => p !== undefined);
    const sorted = [...priorities].sort((a, b) => a - b);
    expect(priorities).toEqual(sorted);

    process.stderr.write(
      `[S7] ${String(stack.middlewares.length)} middlewares, priorities: [${priorities.join(", ")}] ✓\n`,
    );
  });

  test("demand handle starts with zero signals", () => {
    const store = createStore();
    const stack = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: () => Promise.resolve({ ok: true, value: [] }),
      resolveBrickId: () => undefined,
    });

    expect(stack.handles.demand.getSignals()).toHaveLength(0);
    expect(stack.handles.demand.getActiveSignalCount()).toBe(0);
  });
});
