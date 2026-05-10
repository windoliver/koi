import { expect, test } from "bun:test";
import { createBudgetLedger } from "./budget.js";

test("refuses a slice that would spend the reserve", () => {
  const ledger = createBudgetLedger({ total: 100, reserve: 10, defaultSlice: 30 });

  expect(ledger.assign("task_a")).toBe(30);
  expect(ledger.assign("task_b")).toBe(30);
  expect(ledger.assign("task_c")).toBe(30);
  expect(() => ledger.assign("task_d")).toThrow("Insufficient remaining budget for task task_d");
});

test("tracks explicit slice assignments and remaining budget", () => {
  const ledger = createBudgetLedger({ total: 90, reserve: 15, defaultSlice: 20 });

  expect(ledger.assign("task_a", 10)).toBe(10);
  expect(ledger.assign("task_b", 25)).toBe(25);
  expect(ledger.spent()).toBe(35);
  expect(ledger.remaining()).toBe(40);
});

test("defaults slices to the spendable budget when reserve is configured", () => {
  const ledger = createBudgetLedger({ total: 100, reserve: 10 });

  expect(ledger.assign("task_a")).toBe(90);
  expect(ledger.remaining()).toBe(0);
  expect(() => ledger.assign("task_b", 1)).toThrow("Insufficient remaining budget for task task_b");
});

test("treats negative reserve as zero for spendable budget calculations", () => {
  const ledger = createBudgetLedger({ total: 100, reserve: -25 });

  expect(ledger.assign("task_a")).toBe(100);
  expect(ledger.remaining()).toBe(0);
  expect(() => ledger.assign("task_b", 1)).toThrow("Insufficient remaining budget for task task_b");
});

test("fails omitted default slices as insufficient budget when nothing is spendable", () => {
  const ledger = createBudgetLedger({ total: 100, reserve: 100 });

  expect(ledger.remaining()).toBe(0);
  expect(() => ledger.assign("task_a")).toThrow("Insufficient remaining budget for task task_a");
});

test("treats explicit undefined amount like an omitted amount", () => {
  const ledger = createBudgetLedger({ total: 100, reserve: 100 });

  expect(() => ledger.assign("task_a", undefined)).toThrow(
    "Insufficient remaining budget for task task_a",
  );
});

test("rejects an explicit invalid configured default slice", () => {
  const ledger = createBudgetLedger({ total: 100, defaultSlice: 0 });

  expect(() => ledger.assign("task_a")).toThrow("Budget slice for task task_a must be > 0");
});

test("rejects non-finite total budget values", () => {
  expect(() => createBudgetLedger({ total: Number.NaN })).toThrow(
    "Team budget total must be finite",
  );
  expect(() => createBudgetLedger({ total: Number.POSITIVE_INFINITY })).toThrow(
    "Team budget total must be finite",
  );
});

test("rejects non-finite reserve budget values", () => {
  expect(() => createBudgetLedger({ total: 100, reserve: Number.NaN })).toThrow(
    "Team budget reserve must be finite",
  );
  expect(() => createBudgetLedger({ total: 100, reserve: Number.POSITIVE_INFINITY })).toThrow(
    "Team budget reserve must be finite",
  );
});
