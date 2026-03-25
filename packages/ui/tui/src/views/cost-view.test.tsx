import { describe, expect, test } from "bun:test";
import { createInitialCostView } from "../state/domain-types.js";
import type { CostViewState } from "../state/domain-types.js";
import type { CostSnapshot } from "@koi/dashboard-types";
import type { AgentId } from "@koi/core";
import { CostView } from "./cost-view.js";

function makeCostSnapshot(): CostSnapshot {
  return {
    sessionBudget: { used: 0.24, limit: 2.0 },
    dailyBudget: { used: 0.87, limit: 10.0 },
    monthlyBudget: { used: 4.12, limit: 50.0 },
    agents: [
      {
        agentId: "agent-1" as AgentId,
        name: "daily-briefer",
        model: "haiku-4.5",
        turns: 42,
        costUsd: 0.03,
        budgetUsed: 0.03,
        budgetLimit: 2.0,
      },
      {
        agentId: "agent-2" as AgentId,
        name: "code-copilot",
        model: "sonnet-4.5",
        turns: 18,
        costUsd: 0.15,
        budgetUsed: 0.15,
        budgetLimit: 2.0,
      },
    ],
    cascade: {
      tiers: [
        { model: "haiku", calls: 48, costUsd: 0.05, percentOfCalls: 72, label: "cheapest" },
        { model: "sonnet", calls: 18, costUsd: 0.17, percentOfCalls: 27, label: "escalated" },
        { model: "opus", calls: 1, costUsd: 0.02, percentOfCalls: 1, label: "complex" },
      ],
      savingsUsd: 1.43,
      baselineModel: "sonnet",
    },
    circuitBreaker: {
      state: "CLOSED",
      failures: 0,
      threshold: 5,
      windowMs: 60_000,
    },
    timestamp: Date.now(),
  };
}

describe("CostView", () => {
  test("is a function component", () => {
    expect(typeof CostView).toBe("function");
  });

  test("accepts CostViewState props without agents", () => {
    const props = {
      costView: createInitialCostView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.costView.scrollOffset).toBe(0);
    expect(props.costView.snapshot).toBeNull();
    expect(props.costView.loading).toBe(false);
  });

  test("initial state has zero scroll offset and null snapshot", () => {
    const state = createInitialCostView();
    expect(state.scrollOffset).toBe(0);
    expect(state.snapshot).toBeNull();
    expect(state.loading).toBe(false);
  });

  test("state with snapshot is well-typed", () => {
    const snapshot = makeCostSnapshot();
    const state: CostViewState = {
      scrollOffset: 0,
      snapshot,
      loading: false,
    };
    expect(state.snapshot).not.toBeNull();
    expect(state.snapshot!.agents).toHaveLength(2);
    expect(state.snapshot!.cascade.tiers).toHaveLength(3);
    expect(state.snapshot!.circuitBreaker.state).toBe("CLOSED");
    expect(state.snapshot!.sessionBudget.used).toBe(0.24);
  });
});
