import type { TeamBudgetPolicy } from "./spec.js";

export interface TeamBudgetLedger {
  readonly assign: (taskId: string, amount?: number) => number;
  readonly spent: () => number;
  readonly remaining: () => number;
}

export function createBudgetLedger(policy: TeamBudgetPolicy): TeamBudgetLedger {
  if (!Number.isFinite(policy.total)) {
    throw new Error("Team budget total must be finite");
  }
  if (policy.reserve !== undefined && !Number.isFinite(policy.reserve)) {
    throw new Error("Team budget reserve must be finite");
  }

  const reserve = Math.max(0, policy.reserve ?? 0);
  const spendableBudget = Math.max(0, policy.total - reserve);
  const configuredDefaultSlice = policy.defaultSlice;
  const defaultSlice = configuredDefaultSlice ?? spendableBudget;
  let spent = 0;

  return {
    assign(taskId, amount) {
      const usesImplicitDefault = amount === undefined;
      const resolvedAmount = amount ?? defaultSlice;
      const usesImplicitSpendableFallback =
        usesImplicitDefault && configuredDefaultSlice === undefined;

      if (!Number.isFinite(resolvedAmount)) {
        throw new Error(`Budget slice for task ${taskId} must be > 0`);
      }
      if (resolvedAmount <= 0) {
        if (usesImplicitSpendableFallback) {
          throw new Error(`Insufficient remaining budget for task ${taskId}`);
        }
        throw new Error(`Budget slice for task ${taskId} must be > 0`);
      }
      if (spent + resolvedAmount > spendableBudget) {
        throw new Error(`Insufficient remaining budget for task ${taskId}`);
      }
      spent += resolvedAmount;
      return resolvedAmount;
    },
    spent() {
      return spent;
    },
    remaining() {
      return spendableBudget - spent;
    },
  };
}
