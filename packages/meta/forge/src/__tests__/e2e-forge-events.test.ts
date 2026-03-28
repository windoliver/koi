/**
 * E2E test — forge event bridge subKind dispatch and microtask batching.
 *
 * Covers: every ForgeDashboardEvent subKind, microtask batching semantics,
 * payload correctness, error isolation, and ignored policy actions.
 */

import { describe, expect, mock, test } from "bun:test";
import type { BrickArtifact, ForgeDemandSignal } from "@koi/core";
import { brickId } from "@koi/core";
import type { CrystallizationCandidate, CrystallizedToolDescriptor } from "@koi/crystallize";
import type { ForgeDashboardEvent } from "@koi/dashboard-types";
import type { OptimizationResult } from "@koi/forge-optimizer";
import { createForgeEventBridge } from "../forge-event-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockCandidate(): CrystallizationCandidate {
  return {
    ngram: { steps: [{ toolId: "fetch" }, { toolId: "parse" }], key: "fetch|parse" },
    occurrences: 5,
    turnIndices: [0, 1, 2, 3, 4],
    detectedAt: 1000,
    suggestedName: "fetch-then-parse",
    score: 0.95,
  };
}

function createMockDescriptor(): CrystallizedToolDescriptor {
  return {
    name: "fetch-then-parse",
    description: "Fetches and parses data",
    implementation: "// code",
    inputSchema: {},
    scope: "agent",
    origin: "forged",
    policy: { sandbox: true, maxRetries: 3, timeoutMs: 5000 },
    provenance: {
      source: "crystallize",
      ngramKey: "fetch|parse",
      occurrences: 5,
      score: 0.95,
    },
  } as unknown as CrystallizedToolDescriptor;
}

function createMockDemandSignal(): ForgeDemandSignal {
  return {
    id: "demand-1",
    kind: "forge_demand",
    trigger: { kind: "no_matching_tool", query: "visualize", attempts: 1 },
    confidence: 0.9,
    suggestedBrickKind: "tool",
    context: { failureCount: 1, failedToolCalls: [] },
    emittedAt: 1000,
  };
}

function createMockBrickArtifact(): BrickArtifact {
  return {
    id: brickId("sha256:abc123"),
    kind: "tool",
    name: "visualize-tool",
    description: "Visualizes data",
    scope: "agent",
    origin: "demand",
    policy: { sandbox: true, maxRetries: 3, timeoutMs: 5000 },
    lifecycle: "active",
    provenance: { source: { origin: "forged", forgedBy: "demand", sessionId: "s-1" } },
    implementation: "// code",
    inputSchema: {},
  } as unknown as BrickArtifact;
}

function createOptimizationResult(action: OptimizationResult["action"]): OptimizationResult {
  return {
    brickId: brickId("brick-1"),
    action,
    fitnessOriginal: 0.85,
    reason: `action: ${action}`,
  } as OptimizationResult;
}

/** Flush the microtask queue so batched events are delivered. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("forge event bridge", () => {
  // ---- 1. Each subKind fires correctly ----

  describe("subKind dispatch", () => {
    test("onCandidatesDetected emits crystallize_candidate", async () => {
      const received: readonly ForgeDashboardEvent[][] = [];
      const bridge = createForgeEventBridge({
        onDashboardEvent: (events) => {
          (received as ForgeDashboardEvent[][]).push([...events]);
        },
        clock: () => 1000,
      });

      bridge.onCandidatesDetected([createMockCandidate()]);
      await flushMicrotasks();

      expect(received.length).toBe(1);
      expect(received[0]?.[0]?.subKind).toBe("crystallize_candidate");
    });

    test("onDemand emits demand_detected", async () => {
      const received: readonly ForgeDashboardEvent[][] = [];
      const bridge = createForgeEventBridge({
        onDashboardEvent: (events) => {
          (received as ForgeDashboardEvent[][]).push([...events]);
        },
        clock: () => 1000,
      });

      bridge.onDemand(createMockDemandSignal());
      await flushMicrotasks();

      expect(received.length).toBe(1);
      expect(received[0]?.[0]?.subKind).toBe("demand_detected");
    });

    test("onForged emits brick_forged", async () => {
      const received: readonly ForgeDashboardEvent[][] = [];
      const bridge = createForgeEventBridge({
        onDashboardEvent: (events) => {
          (received as ForgeDashboardEvent[][]).push([...events]);
        },
        clock: () => 1000,
      });

      bridge.onForged(createMockDescriptor());
      await flushMicrotasks();

      expect(received.length).toBe(1);
      expect(received[0]?.[0]?.subKind).toBe("brick_forged");
    });

    test("onDemandForged emits brick_demand_forged", async () => {
      const received: readonly ForgeDashboardEvent[][] = [];
      const bridge = createForgeEventBridge({
        onDashboardEvent: (events) => {
          (received as ForgeDashboardEvent[][]).push([...events]);
        },
        clock: () => 1000,
      });

      bridge.onDemandForged(createMockDemandSignal(), createMockBrickArtifact());
      await flushMicrotasks();

      expect(received.length).toBe(1);
      expect(received[0]?.[0]?.subKind).toBe("brick_demand_forged");
    });

    test("onPolicyPromotion with deprecate emits brick_deprecated", async () => {
      const received: readonly ForgeDashboardEvent[][] = [];
      const bridge = createForgeEventBridge({
        onDashboardEvent: (events) => {
          (received as ForgeDashboardEvent[][]).push([...events]);
        },
        clock: () => 1000,
      });

      bridge.onPolicyPromotion("brick-1", createOptimizationResult("deprecate"));
      await flushMicrotasks();

      expect(received.length).toBe(1);
      expect(received[0]?.[0]?.subKind).toBe("brick_deprecated");
    });

    test("onPolicyPromotion with promote_to_policy emits brick_promoted", async () => {
      const received: readonly ForgeDashboardEvent[][] = [];
      const bridge = createForgeEventBridge({
        onDashboardEvent: (events) => {
          (received as ForgeDashboardEvent[][]).push([...events]);
        },
        clock: () => 1000,
      });

      bridge.onPolicyPromotion("brick-1", createOptimizationResult("promote_to_policy"));
      await flushMicrotasks();

      expect(received.length).toBe(1);
      expect(received[0]?.[0]?.subKind).toBe("brick_promoted");
    });

    test("onQuarantine emits brick_quarantined", async () => {
      const received: readonly ForgeDashboardEvent[][] = [];
      const bridge = createForgeEventBridge({
        onDashboardEvent: (events) => {
          (received as ForgeDashboardEvent[][]).push([...events]);
        },
        clock: () => 1000,
      });

      bridge.onQuarantine("brick-1");
      await flushMicrotasks();

      expect(received.length).toBe(1);
      expect(received[0]?.[0]?.subKind).toBe("brick_quarantined");
    });

    test("onFitnessFlush emits fitness_flushed", async () => {
      const received: readonly ForgeDashboardEvent[][] = [];
      const bridge = createForgeEventBridge({
        onDashboardEvent: (events) => {
          (received as ForgeDashboardEvent[][]).push([...events]);
        },
        clock: () => 1000,
      });

      bridge.onFitnessFlush("brick-1", 0.95, 42);
      await flushMicrotasks();

      expect(received.length).toBe(1);
      expect(received[0]?.[0]?.subKind).toBe("fitness_flushed");
    });
  });

  // ---- 2. Microtask batching ----

  test("multiple synchronous events are batched into a single delivery", async () => {
    const onDashboardEvent = mock((_events: readonly ForgeDashboardEvent[]) => {});
    const bridge = createForgeEventBridge({
      onDashboardEvent,
      clock: () => 1000,
    });

    // Fire three events synchronously — no awaits between them
    bridge.onQuarantine("brick-a");
    bridge.onQuarantine("brick-b");
    bridge.onFitnessFlush("brick-c", 0.8, 10);

    await flushMicrotasks();

    // All three should arrive in a single batch call
    expect(onDashboardEvent).toHaveBeenCalledTimes(1);
    const batch = onDashboardEvent.mock.calls[0]?.[0];
    expect(batch?.length).toBe(3);
  });

  // ---- 3. fitness_flushed payload ----

  test("fitness_flushed contains correct brickId, successRate, and sampleCount", async () => {
    const received: ForgeDashboardEvent[] = [];
    const bridge = createForgeEventBridge({
      onDashboardEvent: (events) => {
        for (const e of events) (received as ForgeDashboardEvent[]).push(e);
      },
      clock: () => 2000,
    });

    bridge.onFitnessFlush("brick-1", 0.95, 42);
    await flushMicrotasks();

    expect(received.length).toBe(1);
    const event = received[0] as Record<string, unknown>;
    expect(event.subKind).toBe("fitness_flushed");
    expect(event.brickId).toBe("brick-1");
    expect(event.successRate).toBe(0.95);
    expect(event.sampleCount).toBe(42);
    expect(event.timestamp).toBe(2000);
  });

  // ---- 4. Bridge error isolation ----

  test("onDashboardEvent throwing does not propagate; onBridgeError catches it", async () => {
    const thrownError = new Error("dashboard kaboom");
    const onBridgeError = mock((_err: unknown) => {});

    const bridge = createForgeEventBridge({
      onDashboardEvent: () => {
        throw thrownError;
      },
      onBridgeError,
      clock: () => 1000,
    });

    // Should not throw
    bridge.onQuarantine("brick-1");
    await flushMicrotasks();

    expect(onBridgeError).toHaveBeenCalledTimes(1);
    expect(onBridgeError.mock.calls[0]?.[0]).toBe(thrownError);
  });

  // ---- 5. onPolicyPromotion ignores non-deprecate/promote actions ----

  test("onPolicyPromotion with keep action emits no event", async () => {
    const onDashboardEvent = mock((_events: readonly ForgeDashboardEvent[]) => {});
    const bridge = createForgeEventBridge({
      onDashboardEvent,
      clock: () => 1000,
    });

    bridge.onPolicyPromotion("brick-1", createOptimizationResult("keep"));
    await flushMicrotasks();

    expect(onDashboardEvent).not.toHaveBeenCalled();
  });
});
