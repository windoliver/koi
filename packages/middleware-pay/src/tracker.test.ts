import { describe, expect, test } from "bun:test";
import { createDefaultCostCalculator, createInMemoryPayLedger } from "./tracker.js";

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
