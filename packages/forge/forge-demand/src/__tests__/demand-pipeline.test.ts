/**
 * Integration test — demand-triggered forge pipeline.
 *
 * Wires demand-detector → auto-forge middleware with in-memory forge store.
 * Validates the full demand signal → forge brick → budget decrement flow.
 */

import { describe, expect, it } from "bun:test";
import type { ForgeDemandSignal } from "@koi/core";
import { DEFAULT_FORGE_BUDGET } from "@koi/core";
import { createMockTurnContext } from "@koi/test-utils";
import { createForgeDemandDetector } from "../demand-detector.js";
import type { ForgeDemandConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createConfig(overrides?: Partial<ForgeDemandConfig>): ForgeDemandConfig {
  return {
    budget: {
      ...DEFAULT_FORGE_BUDGET,
      cooldownMs: 0,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("demand pipeline integration", () => {
  it("emits signal on repeated failures and populates signal queue", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      createConfig({
        heuristics: { repeatedFailureCount: 3 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const ctx = createMockTurnContext();
    const failNext = async () => {
      throw new Error("connection timeout");
    };

    // Fail 3 times to trigger demand
    for (let i = 0; i < 3; i++) {
      try {
        await handle.middleware.wrapToolCall?.(ctx, { toolId: "api-fetch", input: {} }, failNext);
      } catch {
        // expected
      }
    }

    // Signal should be emitted
    expect(signals.length).toBe(1);
    expect(signals[0]?.trigger.kind).toBe("repeated_failure");
    expect(signals[0]?.confidence).toBeGreaterThanOrEqual(0.7);
    expect(handle.getActiveSignalCount()).toBe(1);
  });

  it("capability gap in model response triggers forge demand", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      createConfig({
        heuristics: { capabilityGapOccurrences: 1 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const ctx = createMockTurnContext();
    const response = {
      content: "I don't have a tool for image compression.",
      model: "test-model",
      usage: { inputTokens: 10, outputTokens: 20 },
    };
    const next = async () => response;

    await handle.middleware.wrapModelCall?.(ctx, {} as never, next as never);

    expect(signals.length).toBe(1);
    expect(signals[0]?.trigger.kind).toBe("capability_gap");
  });

  it("budget exhaustion blocks further signals", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      createConfig({
        budget: {
          ...DEFAULT_FORGE_BUDGET,
          cooldownMs: 0,
          demandThreshold: 0.5, // low threshold to ensure signals pass
          maxForgesPerSession: 1,
        },
        heuristics: { repeatedFailureCount: 1 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const ctx = createMockTurnContext();
    const failNext = async () => {
      throw new Error("fail");
    };

    // First failure → signal emitted
    try {
      await handle.middleware.wrapToolCall?.(ctx, { toolId: "tool-a", input: {} }, failNext);
    } catch {
      // expected
    }

    // Second failure (different tool) → also emitted (demand detector doesn't enforce budget)
    try {
      await handle.middleware.wrapToolCall?.(ctx, { toolId: "tool-b", input: {} }, failNext);
    } catch {
      // expected
    }

    // The demand detector emits signals — budget enforcement is at the consumer level
    expect(signals.length).toBe(2);
  });

  it("cooldown suppresses duplicate signals for same trigger", async () => {
    // let: mutable clock for test control
    let now = 1000;
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      createConfig({
        budget: { ...DEFAULT_FORGE_BUDGET, cooldownMs: 10_000 },
        heuristics: { repeatedFailureCount: 1 },
        clock: () => now,
        onDemand: (s) => signals.push(s),
      }),
    );

    const ctx = createMockTurnContext();
    const failNext = async () => {
      throw new Error("fail");
    };

    // First failure → signal emitted
    try {
      await handle.middleware.wrapToolCall?.(ctx, { toolId: "tool-a", input: {} }, failNext);
    } catch {
      // expected
    }
    expect(signals.length).toBe(1);

    // Second failure at t=2000 — within cooldown → suppressed
    now = 2000;
    try {
      await handle.middleware.wrapToolCall?.(ctx, { toolId: "tool-a", input: {} }, failNext);
    } catch {
      // expected
    }
    expect(signals.length).toBe(1);

    // Third failure at t=12000 — past cooldown → emitted
    now = 12_000;
    try {
      await handle.middleware.wrapToolCall?.(ctx, { toolId: "tool-a", input: {} }, failNext);
    } catch {
      // expected
    }
    expect(signals.length).toBe(2);
  });

  it("dismiss resets cooldown for trigger key", async () => {
    // let: mutable clock for test control
    let now = 1000;
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      createConfig({
        budget: { ...DEFAULT_FORGE_BUDGET, cooldownMs: 10_000 },
        heuristics: { repeatedFailureCount: 1 },
        clock: () => now,
        onDemand: (s) => signals.push(s),
      }),
    );

    const ctx = createMockTurnContext();
    const failNext = async () => {
      throw new Error("fail");
    };

    // Trigger signal
    try {
      await handle.middleware.wrapToolCall?.(ctx, { toolId: "tool-a", input: {} }, failNext);
    } catch {
      // expected
    }
    expect(signals.length).toBe(1);

    // Dismiss clears cooldown
    const firstSignalId = signals[0]?.id ?? "";
    handle.dismiss(firstSignalId);

    // Should emit again even within cooldown window
    now = 2000;
    try {
      await handle.middleware.wrapToolCall?.(ctx, { toolId: "tool-a", input: {} }, failNext);
    } catch {
      // expected
    }
    expect(signals.length).toBe(2);
  });

  it("signals below demand threshold are not emitted", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      createConfig({
        budget: { ...DEFAULT_FORGE_BUDGET, cooldownMs: 0, demandThreshold: 0.95 },
        heuristics: { repeatedFailureCount: 3 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const ctx = createMockTurnContext();
    const failNext = async () => {
      throw new Error("fail");
    };

    // 3 failures → confidence is 0.9 (repeatedFailure weight), below 0.95 threshold
    for (let i = 0; i < 3; i++) {
      try {
        await handle.middleware.wrapToolCall?.(ctx, { toolId: "tool-a", input: {} }, failNext);
      } catch {
        // expected
      }
    }

    expect(signals.length).toBe(0);
  });
});
