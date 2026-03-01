/**
 * Cost calculation and in-memory PayLedger for dev/testing.
 */

import type {
  PayBalance,
  PayCanAffordResult,
  PayLedger,
  PayMeterResult,
} from "@koi/core/pay-ledger";

export interface CostCalculator {
  readonly calculate: (model: string, inputTokens: number, outputTokens: number) => number;
}

/**
 * In-memory PayLedger backed by a running spend total.
 * Implements only `meter()`, `getBalance()`, and `canAfford()`.
 * Unused methods (`transfer`, `reserve`, `commit`, `release`) throw.
 */
export function createInMemoryPayLedger(initialBudget: number): PayLedger {
  if (!Number.isFinite(initialBudget) || initialBudget < 0) {
    throw new Error(
      `createInMemoryPayLedger: initialBudget must be a non-negative finite number, got ${String(initialBudget)}`,
    );
  }

  // let justified: mutable spend counter incremented by meter()
  let totalSpend = 0;

  return {
    meter(amount: string, _eventType?: string): PayMeterResult {
      totalSpend += parseFloat(amount);
      return { success: true };
    },

    getBalance(): PayBalance {
      const available = Math.max(0, initialBudget - totalSpend);
      return {
        available: available.toString(),
        reserved: "0",
        total: initialBudget.toString(),
      };
    },

    canAfford(amount: string): PayCanAffordResult {
      return {
        canAfford: totalSpend + parseFloat(amount) <= initialBudget,
        amount,
      };
    },

    transfer(): never {
      throw new Error("createInMemoryPayLedger: transfer not implemented");
    },

    reserve(): never {
      throw new Error("createInMemoryPayLedger: reserve not implemented");
    },

    commit(): never {
      throw new Error("createInMemoryPayLedger: commit not implemented");
    },

    release(): never {
      throw new Error("createInMemoryPayLedger: release not implemented");
    },
  };
}

/**
 * Default cost calculator with simple per-token pricing.
 */
export function createDefaultCostCalculator(
  rates?: Partial<Record<string, { readonly input: number; readonly output: number }>>,
): CostCalculator {
  const defaultRates = {
    input: 0.000003, // $3 per million input tokens
    output: 0.000015, // $15 per million output tokens
  };

  return {
    calculate(model: string, inputTokens: number, outputTokens: number): number {
      const modelRates = rates?.[model];
      const inputRate = modelRates?.input ?? defaultRates.input;
      const outputRate = modelRates?.output ?? defaultRates.output;
      return inputTokens * inputRate + outputTokens * outputRate;
    },
  };
}
