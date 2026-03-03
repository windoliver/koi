/**
 * Budget tracking interfaces and default implementations.
 *
 * Canonical type definitions live in @koi/core/cost-tracker (L0).
 * This module re-exports them for backward compatibility and provides
 * concrete implementations.
 */

import type {
  BudgetTracker,
  CostBreakdown,
  CostCalculator,
  CostEntry,
  ModelCostBreakdown,
  ToolCostBreakdown,
} from "@koi/core/cost-tracker";
import type {
  PayBalance,
  PayCanAffordResult,
  PayLedger,
  PayMeterResult,
} from "@koi/core/pay-ledger";

// Re-export L0 types for backward compatibility
export type { BudgetTracker, CostCalculator, CostEntry } from "@koi/core/cost-tracker";

/** Mutable per-model aggregate (internal bookkeeping, never leaked). */
interface MutableModelAgg {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  callCount: number;
}

/** Mutable per-tool aggregate (internal bookkeeping, never leaked). */
interface MutableToolAgg {
  totalCostUsd: number;
  callCount: number;
}

/** Mutable per-session aggregate (internal bookkeeping, never leaked). */
interface SessionAgg {
  totalCostUsd: number;
  readonly byModel: Map<string, MutableModelAgg>;
  readonly byTool: Map<string, MutableToolAgg>;
}

function getOrCreateSession(sessions: Map<string, SessionAgg>, sessionId: string): SessionAgg {
  const existing = sessions.get(sessionId);
  if (existing !== undefined) return existing;
  const fresh: SessionAgg = { totalCostUsd: 0, byModel: new Map(), byTool: new Map() };
  sessions.set(sessionId, fresh);
  return fresh;
}

function freezeBreakdown(agg: SessionAgg): CostBreakdown {
  const byModel: readonly ModelCostBreakdown[] = [...agg.byModel.entries()].map(
    ([model, m]): ModelCostBreakdown => ({
      model,
      totalCostUsd: m.totalCostUsd,
      totalInputTokens: m.totalInputTokens,
      totalOutputTokens: m.totalOutputTokens,
      callCount: m.callCount,
    }),
  );
  const byTool: readonly ToolCostBreakdown[] = [...agg.byTool.entries()].map(
    ([toolName, t]): ToolCostBreakdown => ({
      toolName,
      totalCostUsd: t.totalCostUsd,
      callCount: t.callCount,
    }),
  );
  return { totalCostUsd: agg.totalCostUsd, byModel, byTool };
}

const EMPTY_BREAKDOWN: CostBreakdown = { totalCostUsd: 0, byModel: [], byTool: [] };

/**
 * In-memory PayLedger backed by a running spend total.
 * Implements only `meter()`, `getBalance()`, and `canAfford()`.
 * Unused methods (`transfer`, `reserve`, `commit`, `release`) throw.
 *
 * @deprecated Use `createLocalPayLedger` from `@koi/pay-local` instead.
 * It provides a fully-functional PayLedger with all 7 methods implemented,
 * optional SQLite persistence, and reservation tracking.
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
 * In-memory budget tracker with O(1) pre-aggregated breakdown queries.
 *
 * Aggregates are maintained incrementally on each `record()` call,
 * making `totalSpend()`, `remaining()`, and `breakdown()` all O(1).
 */
export function createInMemoryBudgetTracker(): BudgetTracker {
  const sessions = new Map<string, SessionAgg>();

  return {
    async record(sessionId: string, entry: CostEntry): Promise<void> {
      const agg = getOrCreateSession(sessions, sessionId);

      // Update running total
      agg.totalCostUsd += entry.costUsd;

      // Update per-model aggregate
      const existingModel = agg.byModel.get(entry.model);
      if (existingModel !== undefined) {
        existingModel.totalCostUsd += entry.costUsd;
        existingModel.totalInputTokens += entry.inputTokens;
        existingModel.totalOutputTokens += entry.outputTokens;
        existingModel.callCount += 1;
      } else {
        agg.byModel.set(entry.model, {
          totalCostUsd: entry.costUsd,
          totalInputTokens: entry.inputTokens,
          totalOutputTokens: entry.outputTokens,
          callCount: 1,
        });
      }

      // Update per-tool aggregate (only when toolName is set)
      if (entry.toolName !== undefined) {
        const existingTool = agg.byTool.get(entry.toolName);
        if (existingTool !== undefined) {
          existingTool.totalCostUsd += entry.costUsd;
          existingTool.callCount += 1;
        } else {
          agg.byTool.set(entry.toolName, {
            totalCostUsd: entry.costUsd,
            callCount: 1,
          });
        }
      }
    },

    async totalSpend(sessionId: string): Promise<number> {
      return sessions.get(sessionId)?.totalCostUsd ?? 0;
    },

    async remaining(sessionId: string, budget: number): Promise<number> {
      const spent = sessions.get(sessionId)?.totalCostUsd ?? 0;
      return Math.max(0, budget - spent);
    },

    async breakdown(sessionId: string): Promise<CostBreakdown> {
      const agg = sessions.get(sessionId);
      if (agg === undefined) return EMPTY_BREAKDOWN;
      return freezeBreakdown(agg);
    },
  };
}

/**
 * Default cost calculator with simple per-token pricing.
 *
 * Default rates are rough estimates for illustrative/testing purposes only:
 * - Input: $3 per million tokens ($0.000003/token)
 * - Output: $15 per million tokens ($0.000015/token)
 *
 * Production deployments should supply real rates via the `rates` parameter.
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
