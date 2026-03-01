import { describe, expect, test } from "bun:test";
import type { CostBreakdown, CostEntry } from "@koi/core/cost-tracker";
import {
  createDefaultCostCalculator,
  createInMemoryBudgetTracker,
  createInMemoryPayLedger,
} from "./tracker.js";

describe("createInMemoryPayLedger", () => {
  test("meter and getBalance round-trip", async () => {
    const ledger = createInMemoryPayLedger(10);
    await ledger.meter("0.5", "model_call");
    const balance = await ledger.getBalance();
    expect(parseFloat(balance.available)).toBeCloseTo(9.5);
    expect(balance.total).toBe("10");
  });

  test("fresh ledger has full budget available", async () => {
    const ledger = createInMemoryPayLedger(10);
    const balance = await ledger.getBalance();
    expect(parseFloat(balance.available)).toBe(10);
    expect(balance.reserved).toBe("0");
  });

  test("available never goes below zero", async () => {
    const ledger = createInMemoryPayLedger(10);
    await ledger.meter("15", "model_call");
    const balance = await ledger.getBalance();
    expect(parseFloat(balance.available)).toBe(0);
  });

  test("multiple meter calls accumulate", async () => {
    const ledger = createInMemoryPayLedger(10);
    await ledger.meter("1", "model_call");
    await ledger.meter("2", "model_call");
    await ledger.meter("3", "model_call");
    const balance = await ledger.getBalance();
    expect(parseFloat(balance.available)).toBeCloseTo(4);
  });

  test("meter returns success", async () => {
    const ledger = createInMemoryPayLedger(10);
    const result = await ledger.meter("1", "model_call");
    expect(result.success).toBe(true);
  });

  test("canAfford returns true when within budget", async () => {
    const ledger = createInMemoryPayLedger(10);
    const result = await ledger.canAfford("5");
    expect(result.canAfford).toBe(true);
    expect(result.amount).toBe("5");
  });

  test("canAfford returns false when over budget", async () => {
    const ledger = createInMemoryPayLedger(10);
    await ledger.meter("8", "model_call");
    const result = await ledger.canAfford("5");
    expect(result.canAfford).toBe(false);
  });

  test("transfer throws not implemented", () => {
    const ledger = createInMemoryPayLedger(10);
    expect(() => ledger.transfer("agent-b", "5")).toThrow("transfer not implemented");
  });

  test("reserve throws not implemented", () => {
    const ledger = createInMemoryPayLedger(10);
    expect(() => ledger.reserve("5")).toThrow("reserve not implemented");
  });

  test("commit throws not implemented", () => {
    const ledger = createInMemoryPayLedger(10);
    expect(() => ledger.commit("rsv-1")).toThrow("commit not implemented");
  });

  test("release throws not implemented", () => {
    const ledger = createInMemoryPayLedger(10);
    expect(() => ledger.release("rsv-1")).toThrow("release not implemented");
  });

  test("rejects negative initialBudget", () => {
    expect(() => createInMemoryPayLedger(-1)).toThrow("non-negative finite number");
  });

  test("rejects NaN initialBudget", () => {
    expect(() => createInMemoryPayLedger(NaN)).toThrow("non-negative finite number");
  });

  test("rejects Infinity initialBudget", () => {
    expect(() => createInMemoryPayLedger(Infinity)).toThrow("non-negative finite number");
  });
});

describe("InMemoryBudgetTracker", () => {
  const makeCostEntry = (costUsd: number, model = "test-model"): CostEntry => ({
    inputTokens: 100,
    outputTokens: 50,
    model,
    costUsd,
    timestamp: Date.now(),
  });

  test("record and totalSpend round-trip", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(0.5));
    const total = await tracker.totalSpend("s1");
    expect(total).toBe(0.5);
  });

  test("empty session has zero spend", async () => {
    const tracker = createInMemoryBudgetTracker();
    const total = await tracker.totalSpend("s1");
    expect(total).toBe(0);
  });

  test("remaining calculation", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(3));
    const rem = await tracker.remaining("s1", 10);
    expect(rem).toBe(7);
  });

  test("remaining never goes below zero", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(15));
    const rem = await tracker.remaining("s1", 10);
    expect(rem).toBe(0);
  });

  test("multiple sessions are isolated", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(5));
    await tracker.record("s2", makeCostEntry(3));
    expect(await tracker.totalSpend("s1")).toBe(5);
    expect(await tracker.totalSpend("s2")).toBe(3);
  });

  test("multiple records accumulate", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(1));
    await tracker.record("s1", makeCostEntry(2));
    await tracker.record("s1", makeCostEntry(3));
    expect(await tracker.totalSpend("s1")).toBe(6);
  });

  test("breakdown returns empty for unknown session", async () => {
    const tracker = createInMemoryBudgetTracker();
    const bd: CostBreakdown = await tracker.breakdown("unknown");
    expect(bd.totalCostUsd).toBe(0);
    expect(bd.byModel).toEqual([]);
    expect(bd.byTool).toEqual([]);
  });

  test("breakdown returns single model entry", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(0.5, "gpt-4"));
    const bd = await tracker.breakdown("s1");
    expect(bd.totalCostUsd).toBe(0.5);
    expect(bd.byModel).toHaveLength(1);
    expect(bd.byModel[0]?.model).toBe("gpt-4");
    expect(bd.byModel[0]?.callCount).toBe(1);
    expect(bd.byModel[0]?.totalCostUsd).toBe(0.5);
  });

  test("breakdown aggregates multiple models", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(1.0, "gpt-4"));
    await tracker.record("s1", makeCostEntry(0.5, "claude-3"));
    await tracker.record("s1", makeCostEntry(2.0, "gpt-4"));
    const bd = await tracker.breakdown("s1");
    expect(bd.totalCostUsd).toBe(3.5);
    expect(bd.byModel).toHaveLength(2);
    const gpt4 = bd.byModel.find((m) => m.model === "gpt-4");
    expect(gpt4?.totalCostUsd).toBe(3.0);
    expect(gpt4?.callCount).toBe(2);
    const claude = bd.byModel.find((m) => m.model === "claude-3");
    expect(claude?.totalCostUsd).toBe(0.5);
    expect(claude?.callCount).toBe(1);
  });

  test("breakdown aggregates by tool when toolName set", async () => {
    const tracker = createInMemoryBudgetTracker();
    const entry: CostEntry = {
      inputTokens: 100,
      outputTokens: 50,
      model: "gpt-4",
      costUsd: 0.5,
      timestamp: Date.now(),
      toolName: "web-search",
    };
    await tracker.record("s1", entry);
    await tracker.record("s1", { ...entry, costUsd: 0.3 });
    const bd = await tracker.breakdown("s1");
    expect(bd.byTool).toHaveLength(1);
    expect(bd.byTool[0]?.toolName).toBe("web-search");
    expect(bd.byTool[0]?.totalCostUsd).toBeCloseTo(0.8);
    expect(bd.byTool[0]?.callCount).toBe(2);
  });

  test("breakdown handles mixed entries with and without toolName", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(1.0)); // no toolName
    await tracker.record("s1", {
      inputTokens: 100,
      outputTokens: 50,
      model: "test-model",
      costUsd: 0.5,
      timestamp: Date.now(),
      toolName: "code-search",
    });
    const bd = await tracker.breakdown("s1");
    expect(bd.totalCostUsd).toBe(1.5);
    expect(bd.byModel).toHaveLength(1); // same model
    expect(bd.byTool).toHaveLength(1); // only the one with toolName
    expect(bd.byTool[0]?.toolName).toBe("code-search");
  });

  test("breakdown totalCostUsd matches totalSpend", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(1.0));
    await tracker.record("s1", makeCostEntry(2.5));
    await tracker.record("s1", makeCostEntry(0.3));
    const bd = await tracker.breakdown("s1");
    const totalSpend = await tracker.totalSpend("s1");
    expect(bd.totalCostUsd).toBeCloseTo(totalSpend);
  });

  test("breakdown handles floating point accumulation", async () => {
    const tracker = createInMemoryBudgetTracker();
    // These values demonstrate floating point accumulation
    await tracker.record("s1", makeCostEntry(0.1));
    await tracker.record("s1", makeCostEntry(0.2));
    await tracker.record("s1", makeCostEntry(0.3));
    const bd = await tracker.breakdown("s1");
    // Using toBeCloseTo to handle floating-point precision
    expect(bd.totalCostUsd).toBeCloseTo(0.6, 10);
  });
});

describe("DefaultCostCalculator", () => {
  test("calculates cost with default rates", () => {
    const calc = createDefaultCostCalculator();
    const cost = calc.calculate("gpt-4", 1000, 500);
    // 1000 * 0.000003 + 500 * 0.000015 = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  test("uses custom model rates", () => {
    const calc = createDefaultCostCalculator({
      "cheap-model": { input: 0.000001, output: 0.000002 },
    });
    const cost = calc.calculate("cheap-model", 1000, 1000);
    // 1000 * 0.000001 + 1000 * 0.000002 = 0.001 + 0.002 = 0.003
    expect(cost).toBeCloseTo(0.003, 6);
  });

  test("falls back to default rates for unknown models", () => {
    const calc = createDefaultCostCalculator({
      "known-model": { input: 0.000001, output: 0.000001 },
    });
    const cost = calc.calculate("unknown-model", 1000, 500);
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  test("zero tokens produce zero cost", () => {
    const calc = createDefaultCostCalculator();
    expect(calc.calculate("gpt-4", 0, 0)).toBe(0);
  });
});
