import { describe, expect, test } from "bun:test";
import type { CostEntry } from "@koi/core/cost-tracker";
import type { ThresholdAlert } from "./thresholds.js";
import { createThresholdTracker } from "./thresholds.js";
import { createCostAggregator } from "./tracker.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides?: Partial<CostEntry>): CostEntry {
  return {
    inputTokens: 100,
    outputTokens: 50,
    model: "gpt-4o",
    costUsd: 0.001,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic BudgetTracker contract
// ---------------------------------------------------------------------------

describe("createCostAggregator", () => {
  describe("totalSpend", () => {
    test("returns 0 for unknown session", () => {
      const agg = createCostAggregator();
      expect(agg.totalSpend("unknown")).toBe(0);
    });

    test("accumulates cost across records", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry({ costUsd: 0.01 }));
      agg.record("s1", makeEntry({ costUsd: 0.02 }));
      expect(agg.totalSpend("s1")).toBeCloseTo(0.03, 10);
    });
  });

  describe("remaining", () => {
    test("returns full budget for unknown session", () => {
      const agg = createCostAggregator();
      expect(agg.remaining("unknown", 10)).toBe(10);
    });

    test("subtracts spend from budget", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry({ costUsd: 3 }));
      expect(agg.remaining("s1", 10)).toBeCloseTo(7, 10);
    });

    test("never returns negative", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry({ costUsd: 15 }));
      expect(agg.remaining("s1", 10)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Per-model aggregation
  // -------------------------------------------------------------------------

  describe("breakdown — per-model", () => {
    test("empty session returns empty breakdown", () => {
      const agg = createCostAggregator();
      const bd = agg.breakdown("s1");
      expect(bd.totalCostUsd).toBe(0);
      expect(bd.byModel).toEqual([]);
      expect(bd.byTool).toEqual([]);
    });

    test("single model aggregates correctly", () => {
      const agg = createCostAggregator();
      agg.record(
        "s1",
        makeEntry({ model: "gpt-4o", inputTokens: 100, outputTokens: 50, costUsd: 0.01 }),
      );
      agg.record(
        "s1",
        makeEntry({ model: "gpt-4o", inputTokens: 200, outputTokens: 100, costUsd: 0.02 }),
      );

      const bd = agg.breakdown("s1");
      expect(bd.byModel).toHaveLength(1);
      const m = bd.byModel[0];
      if (m === undefined) throw new Error("model breakdown should exist");
      expect(m.model).toBe("gpt-4o");
      expect(m.totalCostUsd).toBeCloseTo(0.03, 10);
      expect(m.totalInputTokens).toBe(300);
      expect(m.totalOutputTokens).toBe(150);
      expect(m.callCount).toBe(2);
    });

    test("multiple models produce separate breakdowns", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry({ model: "gpt-4o", costUsd: 0.01 }));
      agg.record("s1", makeEntry({ model: "claude-opus-4-6", costUsd: 0.05 }));
      agg.record("s1", makeEntry({ model: "gpt-4o", costUsd: 0.02 }));

      const bd = agg.breakdown("s1");
      expect(bd.byModel).toHaveLength(2);
      expect(bd.totalCostUsd).toBeCloseTo(0.08, 10);
    });
  });

  // -------------------------------------------------------------------------
  // Per-tool aggregation
  // -------------------------------------------------------------------------

  describe("breakdown — per-tool", () => {
    test("entries without toolName produce no tool breakdown", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry());
      expect(agg.breakdown("s1").byTool).toHaveLength(0);
    });

    test("tool attribution aggregates correctly", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry({ toolName: "search", costUsd: 0.01 }));
      agg.record("s1", makeEntry({ toolName: "search", costUsd: 0.02 }));
      agg.record("s1", makeEntry({ toolName: "edit", costUsd: 0.005 }));

      const bd = agg.breakdown("s1");
      expect(bd.byTool).toHaveLength(2);
      const search = bd.byTool.find((t) => t.toolName === "search");
      expect(search?.totalCostUsd).toBeCloseTo(0.03, 10);
      expect(search?.callCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Per-agent aggregation (new dimension)
  // -------------------------------------------------------------------------

  describe("breakdown — per-agent", () => {
    test("entries without agentId produce no agent breakdown", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry());
      expect(agg.breakdown("s1").byAgent).toBeUndefined();
    });

    test("per-agent aggregation tracks cost correctly", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry({ agentId: "agent-1", costUsd: 0.01 }));
      agg.record("s1", makeEntry({ agentId: "agent-2", costUsd: 0.05 }));
      agg.record("s1", makeEntry({ agentId: "agent-1", costUsd: 0.02 }));

      const bd = agg.breakdown("s1");
      expect(bd.byAgent).toHaveLength(2);
      const agent1 = bd.byAgent?.find((a) => a.agentId === "agent-1");
      expect(agent1?.totalCostUsd).toBeCloseTo(0.03, 10);
      expect(agent1?.callCount).toBe(2);
    });

    test("mixed entries with and without agentId", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry({ agentId: "agent-1", costUsd: 0.01 }));
      agg.record("s1", makeEntry({ costUsd: 0.02 })); // no agentId
      agg.record("s1", makeEntry({ agentId: "agent-1", costUsd: 0.03 }));

      const bd = agg.breakdown("s1");
      expect(bd.totalCostUsd).toBeCloseTo(0.06, 10);
      expect(bd.byAgent).toHaveLength(1);
      expect(bd.byAgent?.[0]?.totalCostUsd).toBeCloseTo(0.04, 10);
    });
  });

  // -------------------------------------------------------------------------
  // Per-provider aggregation (new dimension)
  // -------------------------------------------------------------------------

  describe("breakdown — per-provider", () => {
    test("entries without provider produce no provider breakdown", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry());
      expect(agg.breakdown("s1").byProvider).toBeUndefined();
    });

    test("per-provider aggregation tracks cost correctly", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry({ provider: "openai", costUsd: 0.01 }));
      agg.record("s1", makeEntry({ provider: "anthropic", costUsd: 0.05 }));
      agg.record("s1", makeEntry({ provider: "openai", costUsd: 0.02 }));

      const bd = agg.breakdown("s1");
      expect(bd.byProvider).toHaveLength(2);
      const openai = bd.byProvider?.find((p) => p.provider === "openai");
      expect(openai?.totalCostUsd).toBeCloseTo(0.03, 10);
      expect(openai?.callCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-session isolation
  // -------------------------------------------------------------------------

  describe("session isolation", () => {
    test("different sessions have independent state", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry({ costUsd: 0.01 }));
      agg.record("s2", makeEntry({ costUsd: 0.05 }));

      expect(agg.totalSpend("s1")).toBeCloseTo(0.01, 10);
      expect(agg.totalSpend("s2")).toBeCloseTo(0.05, 10);
    });

    test("breakdown is session-scoped", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry({ model: "gpt-4o", costUsd: 0.01 }));
      agg.record("s2", makeEntry({ model: "claude-opus-4-6", costUsd: 0.05 }));

      const bd1 = agg.breakdown("s1");
      expect(bd1.byModel).toHaveLength(1);
      expect(bd1.byModel[0]?.model).toBe("gpt-4o");

      const bd2 = agg.breakdown("s2");
      expect(bd2.byModel).toHaveLength(1);
      expect(bd2.byModel[0]?.model).toBe("claude-opus-4-6");
    });
  });

  // -------------------------------------------------------------------------
  // Ring buffer / entries
  // -------------------------------------------------------------------------

  describe("entries (ring buffer)", () => {
    test("returns entries in insertion order", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry({ costUsd: 0.01, timestamp: 1 }));
      agg.record("s1", makeEntry({ costUsd: 0.02, timestamp: 2 }));
      agg.record("s1", makeEntry({ costUsd: 0.03, timestamp: 3 }));

      const entries = agg.entries();
      expect(entries).toHaveLength(3);
      expect(entries[0]?.costUsd).toBe(0.01);
      expect(entries[2]?.costUsd).toBe(0.03);
    });

    test("respects ring buffer capacity", () => {
      const agg = createCostAggregator({ ringBufferCapacity: 2 });
      agg.record("s1", makeEntry({ costUsd: 0.01 }));
      agg.record("s1", makeEntry({ costUsd: 0.02 }));
      agg.record("s1", makeEntry({ costUsd: 0.03 }));

      const entries = agg.entries();
      expect(entries).toHaveLength(2);
      expect(entries[0]?.costUsd).toBe(0.02);
      expect(entries[1]?.costUsd).toBe(0.03);
    });
  });

  // -------------------------------------------------------------------------
  // clearSession
  // -------------------------------------------------------------------------

  describe("clearSession", () => {
    test("removes all session state", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry({ costUsd: 0.05 }));
      agg.clearSession("s1");

      expect(agg.totalSpend("s1")).toBe(0);
      expect(agg.breakdown("s1").totalCostUsd).toBe(0);
    });

    test("does not affect other sessions", () => {
      const agg = createCostAggregator();
      agg.record("s1", makeEntry({ costUsd: 0.01 }));
      agg.record("s2", makeEntry({ costUsd: 0.05 }));
      agg.clearSession("s1");

      expect(agg.totalSpend("s2")).toBeCloseTo(0.05, 10);
    });
  });

  // -------------------------------------------------------------------------
  // Threshold integration
  // -------------------------------------------------------------------------

  describe("threshold integration", () => {
    test("fires threshold alerts on record", () => {
      const alerts: ThresholdAlert[] = [];
      const thresholdTracker = createThresholdTracker({
        budget: 1.0,
        thresholds: [0.5],
        onAlert: (a) => alerts.push(a),
      });

      const agg = createCostAggregator({ thresholdTracker });
      agg.record("s1", makeEntry({ costUsd: 0.6 }));

      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.threshold).toBe(0.5);
    });

    test("clearSession resets threshold state", () => {
      const alerts: ThresholdAlert[] = [];
      const thresholdTracker = createThresholdTracker({
        budget: 1.0,
        thresholds: [0.5],
        onAlert: (a) => alerts.push(a),
      });

      const agg = createCostAggregator({ thresholdTracker });
      agg.record("s1", makeEntry({ costUsd: 0.6 }));
      agg.clearSession("s1");
      // After clear + new session lifecycle, recording again should fire
      agg.record("s1", makeEntry({ costUsd: 0.6 }));

      expect(alerts).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Degenerate / edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    test("single entry produces valid breakdown", () => {
      const agg = createCostAggregator();
      agg.record(
        "s1",
        makeEntry({
          model: "gpt-4o",
          costUsd: 0.01,
          agentId: "a1",
          provider: "openai",
          toolName: "search",
        }),
      );

      const bd = agg.breakdown("s1");
      expect(bd.totalCostUsd).toBeCloseTo(0.01, 10);
      expect(bd.byModel).toHaveLength(1);
      expect(bd.byTool).toHaveLength(1);
      expect(bd.byAgent).toHaveLength(1);
      expect(bd.byProvider).toHaveLength(1);
    });

    test("many records maintain correct totals", () => {
      const agg = createCostAggregator();
      const n = 1000;
      const perEntry = 0.001;
      for (let i = 0; i < n; i++) {
        agg.record("s1", makeEntry({ costUsd: perEntry }));
      }
      expect(agg.totalSpend("s1")).toBeCloseTo(n * perEntry, 6);
    });
  });
});
