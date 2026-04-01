/**
 * E2E integration test — Forge middleware pipeline without real LLM calls.
 *
 * Tests the full createForgeMiddlewareStack pipeline:
 *   1. Demand detector emits signal on repeated tool failures
 *   2. Demand signal triggers auto-forge -> pioneer brick saved
 *   3. Optimizer session-end sweep deprecates low-fitness brick
 *   4. Cooldown prevents re-signaling while a signal is pending
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, Result, TurnTrace } from "@koi/core";
import { brickId } from "@koi/core";
import type { DashboardEvent, ForgeDashboardEvent } from "@koi/dashboard-types";
import { createInMemoryForgeStore } from "@koi/forge-tools";
import { createDefaultForgeConfig } from "@koi/forge-types";
import {
  createMockSessionContext,
  createMockTurnContext,
  createTestToolArtifact,
  DEFAULT_PROVENANCE,
} from "@koi/test-utils";
import { createForgeMiddlewareStack } from "../create-forge-middleware-stack.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyTraces(): Promise<Result<readonly TurnTrace[], KoiError>> {
  return Promise.resolve({ ok: true, value: [] });
}

function noopResolveBrickId(): string | undefined {
  return undefined;
}

/** Flush fire-and-forget promises (microtask batching + setTimeout). */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

function createToolRequest(toolId: string): {
  readonly toolId: string;
  readonly input: Readonly<Record<string, unknown>>;
} {
  return { toolId, input: {} };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("e2e: forge middleware pipeline (no LLM)", () => {
  test("demand detector emits signal on repeated tool failures", async () => {
    const store = createInMemoryForgeStore();
    const events: ForgeDashboardEvent[] = [];

    const { middlewares } = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: emptyTraces,
      resolveBrickId: noopResolveBrickId,
      onDashboardEvent: (event: DashboardEvent) => {
        if (event.kind === "forge") {
          events.push(event);
        }
      },
    });

    const demandMiddleware = middlewares.find((m) => m.name === "forge-demand-detector");
    expect(demandMiddleware).toBeDefined();

    const ctx = createMockTurnContext();
    const failNext = async (): Promise<never> => {
      throw new Error("connection timeout");
    };

    // Simulate 3 consecutive failures on the same tool (default repeatedFailureCount: 3)
    for (let i = 0; i < 3; i++) {
      try {
        await demandMiddleware?.wrapToolCall?.(ctx, createToolRequest("api-fetch"), failNext);
      } catch {
        // expected — tool call failure propagates
      }
    }

    // Flush microtask-batched bridge events
    await flush();

    const demandEvents = events.filter((e) => e.subKind === "demand_detected");
    expect(demandEvents.length).toBe(1);
    expect(demandEvents[0]?.subKind).toBe("demand_detected");
  });

  test("demand signal triggers auto-forge and saves pioneer brick", async () => {
    const store = createInMemoryForgeStore();
    const events: ForgeDashboardEvent[] = [];

    const { middlewares } = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: emptyTraces,
      resolveBrickId: noopResolveBrickId,
      onDashboardEvent: (event: DashboardEvent) => {
        if (event.kind === "forge") {
          events.push(event);
        }
      },
    });

    const demandMiddleware = middlewares.find((m) => m.name === "forge-demand-detector");
    const autoForgeMiddleware = middlewares.find((m) => m.name === "auto-forge");
    expect(demandMiddleware).toBeDefined();
    expect(autoForgeMiddleware).toBeDefined();

    const ctx = createMockTurnContext();
    const failNext = async (): Promise<never> => {
      throw new Error("connection timeout");
    };

    // Trigger demand with 3 consecutive failures
    for (let i = 0; i < 3; i++) {
      try {
        await demandMiddleware?.wrapToolCall?.(ctx, createToolRequest("api-fetch"), failNext);
      } catch {
        // expected
      }
    }

    // Process demand signals in auto-forge's onAfterTurn
    await autoForgeMiddleware?.onAfterTurn?.(ctx as never);
    await flush();

    // Verify a pioneer brick was saved to the store
    const searchResult = await store.search({ lifecycle: "active" });
    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      const pioneers = searchResult.value.filter((b) => b.name.startsWith("pioneer-"));
      expect(pioneers.length).toBeGreaterThanOrEqual(1);
    }

    // Verify brick_demand_forged dashboard event
    const demandForgedEvents = events.filter((e) => e.subKind === "brick_demand_forged");
    expect(demandForgedEvents.length).toBe(1);
  });

  test("optimizer session-end sweep deprecates low-fitness brick", async () => {
    const store = createInMemoryForgeStore();
    const now = Date.now();

    // Seed store with a crystallized brick that has bad fitness metrics.
    // The ngramKey "fetch|parse" tells the optimizer to compare against
    // component tools named "fetch" and "parse".
    const badBrick = createTestToolArtifact({
      id: brickId("sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234"),
      name: "test-crystallized-tool",
      lifecycle: "active",
      tags: ["crystallized", "auto-forged"],
      fitness: {
        successCount: 1,
        errorCount: 19,
        latency: { samples: [500], count: 1, cap: 200 },
        lastUsedAt: now,
      },
      provenance: {
        ...DEFAULT_PROVENANCE,
        source: { origin: "forged", forgedBy: "auto-forge-middleware", sessionId: "s-1" },
        buildDefinition: {
          buildType: "koi.crystallize/composite/v1",
          externalParameters: {
            ngramKey: "fetch|parse",
            occurrences: 5,
            score: 10,
          },
        },
      },
    });
    await store.save(badBrick);

    // Seed component tools with much better fitness (so composite gets deprecated)
    const fetchBrick = createTestToolArtifact({
      id: brickId("component-fetch-001"),
      name: "fetch",
      lifecycle: "active",
      fitness: {
        successCount: 30,
        errorCount: 0,
        latency: { samples: [50], count: 1, cap: 200 },
        lastUsedAt: now,
      },
    });
    const parseBrick = createTestToolArtifact({
      id: brickId("component-parse-001"),
      name: "parse",
      lifecycle: "active",
      fitness: {
        successCount: 25,
        errorCount: 0,
        latency: { samples: [30], count: 1, cap: 200 },
        lastUsedAt: now,
      },
    });
    await store.save(fetchBrick);
    await store.save(parseBrick);

    const { middlewares } = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: emptyTraces,
      resolveBrickId: noopResolveBrickId,
      clock: () => now,
    });

    const optimizerMiddleware = middlewares.find((m) => m.name === "forge-optimizer");
    expect(optimizerMiddleware).toBeDefined();

    // Trigger optimizer sweep via onSessionEnd
    const sessionCtx = createMockSessionContext();
    await optimizerMiddleware?.onSessionEnd?.(sessionCtx as never);
    await flush();

    // Verify brick lifecycle changed to "deprecated" in store
    const loadResult = await store.load(badBrick.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.lifecycle).toBe("deprecated");
    }

    // Component bricks should remain active
    const fetchResult = await store.load(fetchBrick.id);
    expect(fetchResult.ok).toBe(true);
    if (fetchResult.ok) {
      expect(fetchResult.value.lifecycle).toBe("active");
    }
  });

  test("demand cooldown prevents re-signaling while a signal is pending", async () => {
    const store = createInMemoryForgeStore();
    const events: ForgeDashboardEvent[] = [];

    const { middlewares, handles } = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: emptyTraces,
      resolveBrickId: noopResolveBrickId,
      onDashboardEvent: (event: DashboardEvent) => {
        if (event.kind === "forge") {
          events.push(event);
        }
      },
    });

    const demandMiddleware = middlewares.find((m) => m.name === "forge-demand-detector");
    expect(demandMiddleware).toBeDefined();

    const ctx = createMockTurnContext();
    const failNext = async (): Promise<never> => {
      throw new Error("connection timeout");
    };

    // First batch: trigger demand with 3 failures on "api-fetch"
    for (let i = 0; i < 3; i++) {
      try {
        await demandMiddleware?.wrapToolCall?.(ctx, createToolRequest("api-fetch"), failNext);
      } catch {
        // expected
      }
    }
    await flush();

    // Should have exactly 1 pending signal
    expect(handles.demand.getSignals().length).toBe(1);
    expect(handles.demand.getActiveSignalCount()).toBe(1);

    // Second batch: 3 more failures on the same tool while first signal is pending
    for (let i = 0; i < 3; i++) {
      try {
        await demandMiddleware?.wrapToolCall?.(ctx, createToolRequest("api-fetch"), failNext);
      } catch {
        // expected
      }
    }
    await flush();

    // Cooldown blocks the second signal — still only 1 pending
    expect(handles.demand.getSignals().length).toBe(1);

    // Only 1 demand_detected event total
    const demandDetectedEvents = events.filter((e) => e.subKind === "demand_detected");
    expect(demandDetectedEvents.length).toBe(1);
  });
});
