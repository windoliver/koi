import { describe, expect, test } from "bun:test";
import type { BrickArtifact, BrickId, ForgeDemandSignal } from "@koi/core";
import type { CrystallizationCandidate } from "@koi/crystallize";
import type { ForgeDashboardEvent, MonitorDashboardEvent } from "@koi/dashboard-types";
import type { OptimizationResult } from "@koi/forge-optimizer";
import {
  type AnomalySignalLike,
  createForgeEventBridge,
  createMonitorEventBridge,
} from "./forge-event-bridge.js";

const NOW = 1_000_000;

function makeDemandSignal(overrides?: Partial<ForgeDemandSignal>): ForgeDemandSignal {
  return {
    id: "sig-1",
    kind: "forge_demand",
    trigger: { kind: "capability_gap", requiredCapability: "web_search" },
    confidence: 0.85,
    suggestedBrickKind: "tool",
    context: { failureCount: 3, failedToolCalls: ["search"] },
    emittedAt: NOW,
    ...overrides,
  };
}

function makeCandidate(overrides?: Partial<CrystallizationCandidate>): CrystallizationCandidate {
  return {
    ngram: { steps: [{ toolId: "a" }, { toolId: "b" }], key: "a>b" },
    occurrences: 5,
    turnIndices: [1, 3, 5, 7, 9],
    detectedAt: NOW,
    suggestedName: "ab-combo",
    score: 0.9,
    ...overrides,
  };
}

function makeBrick(overrides?: Partial<BrickArtifact>): BrickArtifact {
  return {
    id: "brick-1" as BrickId,
    kind: "tool",
    name: "web-search",
    description: "Searches the web",
    scope: "agent",
    origin: "forged",
    policy: { sandbox: true, capabilities: {} },
    lifecycle: "active",
    provenance: { source: "crystallize", ngramKey: "a>b", occurrences: 5, score: 0.9 },
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    implementation: "() => {}",
    inputSchema: {},
    ...overrides,
  } as BrickArtifact;
}

function makeOptResult(overrides?: Partial<OptimizationResult>): OptimizationResult {
  return {
    brickId: "brick-1" as BrickId,
    action: "promote_to_policy",
    fitnessOriginal: 0.95,
    reason: "High success rate",
    ...overrides,
  };
}

describe("createForgeEventBridge", () => {
  let emitted: readonly ForgeDashboardEvent[];
  let errors: unknown[];

  function createBridge(): ReturnType<typeof createForgeEventBridge> {
    emitted = [];
    errors = [];
    return createForgeEventBridge({
      onDashboardEvent: (events) => {
        emitted = events;
      },
      onBridgeError: (err) => {
        errors.push(err);
      },
      clock: () => NOW,
    });
  }

  describe("onCandidatesDetected", () => {
    test("emits crystallize_candidate events for each candidate", async () => {
      const bridge = createBridge();
      bridge.onCandidatesDetected([makeCandidate(), makeCandidate({ suggestedName: "cd-combo" })]);
      await Promise.resolve(); // flush microtask
      expect(emitted).toHaveLength(2);
      expect(emitted[0]?.subKind).toBe("crystallize_candidate");
      expect(emitted[0]?.kind).toBe("forge");
      const first = emitted[0] as Extract<
        ForgeDashboardEvent,
        { readonly subKind: "crystallize_candidate" }
      >;
      expect(first.ngramKey).toBe("a>b");
      expect(first.occurrences).toBe(5);
      expect(first.suggestedName).toBe("ab-combo");
      expect(first.score).toBe(0.9);
      expect(first.timestamp).toBe(NOW);
    });
  });

  describe("onForged", () => {
    test("emits brick_forged event from crystallized descriptor", async () => {
      const bridge = createBridge();
      bridge.onForged({
        name: "combo-tool",
        description: "A composite tool",
        implementation: "() => {}",
        inputSchema: {},
        scope: "agent",
        origin: "forged",
        policy: { sandbox: true, capabilities: {} },
        provenance: { source: "crystallize", ngramKey: "a>b>c", occurrences: 7, score: 0.95 },
      });
      await Promise.resolve();
      expect(emitted).toHaveLength(1);
      const ev = emitted[0] as Extract<ForgeDashboardEvent, { readonly subKind: "brick_forged" }>;
      expect(ev.subKind).toBe("brick_forged");
      expect(ev.brickId).toBe("combo-tool");
      expect(ev.name).toBe("combo-tool");
      expect(ev.origin).toBe("crystallize");
      expect(ev.ngramKey).toBe("a>b>c");
      expect(ev.occurrences).toBe(7);
      expect(ev.score).toBe(0.95);
    });
  });

  describe("onDemand", () => {
    test("emits demand_detected event", async () => {
      const bridge = createBridge();
      bridge.onDemand(makeDemandSignal());
      await Promise.resolve();
      expect(emitted).toHaveLength(1);
      const ev = emitted[0] as Extract<
        ForgeDashboardEvent,
        { readonly subKind: "demand_detected" }
      >;
      expect(ev.subKind).toBe("demand_detected");
      expect(ev.signalId).toBe("sig-1");
      expect(ev.triggerKind).toBe("capability_gap");
      expect(ev.confidence).toBe(0.85);
      expect(ev.suggestedBrickKind).toBe("tool");
    });
  });

  describe("onDemandForged", () => {
    test("emits brick_demand_forged event", async () => {
      const bridge = createBridge();
      bridge.onDemandForged(makeDemandSignal(), makeBrick());
      await Promise.resolve();
      expect(emitted).toHaveLength(1);
      const ev = emitted[0] as Extract<
        ForgeDashboardEvent,
        { readonly subKind: "brick_demand_forged" }
      >;
      expect(ev.subKind).toBe("brick_demand_forged");
      expect(ev.brickId).toBe("brick-1");
      expect(ev.name).toBe("web-search");
      expect(ev.triggerId).toBe("sig-1");
      expect(ev.triggerKind).toBe("capability_gap");
      expect(ev.confidence).toBe(0.85);
    });
  });

  describe("onPolicyPromotion", () => {
    test("emits brick_promoted for promote_to_policy action", async () => {
      const bridge = createBridge();
      bridge.onPolicyPromotion("brick-1", makeOptResult({ action: "promote_to_policy" }));
      await Promise.resolve();
      expect(emitted).toHaveLength(1);
      const ev = emitted[0] as Extract<ForgeDashboardEvent, { readonly subKind: "brick_promoted" }>;
      expect(ev.subKind).toBe("brick_promoted");
      expect(ev.brickId).toBe("brick-1");
      expect(ev.fitnessOriginal).toBe(0.95);
    });

    test("emits brick_deprecated for deprecate action", async () => {
      const bridge = createBridge();
      bridge.onPolicyPromotion(
        "brick-2",
        makeOptResult({ action: "deprecate", reason: "Low fitness" }),
      );
      await Promise.resolve();
      expect(emitted).toHaveLength(1);
      const ev = emitted[0] as Extract<
        ForgeDashboardEvent,
        { readonly subKind: "brick_deprecated" }
      >;
      expect(ev.subKind).toBe("brick_deprecated");
      expect(ev.brickId).toBe("brick-2");
      expect(ev.reason).toBe("Low fitness");
    });

    test("does not emit for keep action", async () => {
      const bridge = createBridge();
      bridge.onPolicyPromotion("brick-3", makeOptResult({ action: "keep" }));
      await Promise.resolve();
      expect(emitted).toHaveLength(0);
    });
  });

  describe("onQuarantine", () => {
    test("emits brick_quarantined event", async () => {
      const bridge = createBridge();
      bridge.onQuarantine("brick-1");
      await Promise.resolve();
      expect(emitted).toHaveLength(1);
      const ev = emitted[0] as Extract<
        ForgeDashboardEvent,
        { readonly subKind: "brick_quarantined" }
      >;
      expect(ev.subKind).toBe("brick_quarantined");
      expect(ev.brickId).toBe("brick-1");
    });
  });

  describe("onFitnessFlush", () => {
    test("emits fitness_flushed event", async () => {
      const bridge = createBridge();
      bridge.onFitnessFlush("brick-1", 0.92, 100);
      await Promise.resolve();
      expect(emitted).toHaveLength(1);
      const ev = emitted[0] as Extract<
        ForgeDashboardEvent,
        { readonly subKind: "fitness_flushed" }
      >;
      expect(ev.subKind).toBe("fitness_flushed");
      expect(ev.brickId).toBe("brick-1");
      expect(ev.successRate).toBe(0.92);
      expect(ev.sampleCount).toBe(100);
    });
  });

  describe("microtask batching", () => {
    test("multiple callbacks in same tick are batched into single flush", async () => {
      let batchCount = 0;
      const bridge = createForgeEventBridge({
        onDashboardEvent: () => {
          batchCount++;
        },
        clock: () => NOW,
      });
      bridge.onDemand(makeDemandSignal());
      bridge.onQuarantine("brick-1");
      bridge.onFitnessFlush("brick-2", 0.8, 50);
      await Promise.resolve();
      expect(batchCount).toBe(1);
    });
  });

  describe("error handling", () => {
    test("bridge error in onDashboardEvent calls onBridgeError", async () => {
      const errs: unknown[] = [];
      const bridge = createForgeEventBridge({
        onDashboardEvent: () => {
          throw new Error("sink failed");
        },
        onBridgeError: (err) => {
          errs.push(err);
        },
        clock: () => NOW,
      });
      bridge.onDemand(makeDemandSignal());
      await Promise.resolve();
      expect(errs).toHaveLength(1);
      expect((errs[0] as Error).message).toBe("sink failed");
    });
  });
});

describe("createMonitorEventBridge", () => {
  test("wraps onAnomaly to emit MonitorDashboardEvent", () => {
    const events: MonitorDashboardEvent[] = [];
    const bridge = createMonitorEventBridge({
      onDashboardEvent: (event) => {
        events.push(event);
      },
      clock: () => NOW,
    });

    const signal: AnomalySignalLike = {
      kind: "error_spike",
      agentId: "a-1",
      sessionId: "s-1",
      timestamp: NOW,
      turnIndex: 5,
      errorCount: 10,
    };

    const wrapped = bridge.wrapOnAnomaly();
    wrapped(signal);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("monitor");
    expect(events[0]?.subKind).toBe("anomaly_detected");
    expect(events[0]?.anomalyKind).toBe("error_spike");
    expect(events[0]?.agentId).toBe("a-1");
    expect(events[0]?.sessionId).toBe("s-1");
    expect(events[0]?.timestamp).toBe(NOW);
  });

  test("calls existing onAnomaly handler when provided", () => {
    let existingCalled = false;
    const bridge = createMonitorEventBridge({
      onDashboardEvent: () => {},
      clock: () => NOW,
    });

    const signal: AnomalySignalLike = {
      kind: "tool_rate_exceeded",
      agentId: "a-1",
      sessionId: "s-1",
      timestamp: NOW,
      turnIndex: 3,
    };

    const wrapped = bridge.wrapOnAnomaly(() => {
      existingCalled = true;
    });
    wrapped(signal);

    expect(existingCalled).toBe(true);
  });

  test("handles errors in onDashboardEvent via onBridgeError", () => {
    const errs: unknown[] = [];
    const bridge = createMonitorEventBridge({
      onDashboardEvent: () => {
        throw new Error("emit failed");
      },
      onBridgeError: (err) => {
        errs.push(err);
      },
      clock: () => NOW,
    });

    const wrapped = bridge.wrapOnAnomaly();
    wrapped({
      kind: "error_spike",
      agentId: "a-1",
      sessionId: "s-1",
      timestamp: NOW,
      turnIndex: 1,
    });

    expect(errs).toHaveLength(1);
    expect((errs[0] as Error).message).toBe("emit failed");
  });
});
