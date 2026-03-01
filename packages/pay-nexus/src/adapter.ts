/**
 * PayLedger → BudgetTracker adapter.
 *
 * Bridges the PayLedger contract (Nexus credit ledger) to the
 * BudgetTracker interface used by @koi/middleware-pay.
 *
 * Smart adapter: uses meter() for recording and getBalance() for queries,
 * keeping HTTP calls to 1 per operation.
 */

import type { BudgetTracker, CostBreakdown, CostEntry } from "@koi/core/cost-tracker";
import type { PayLedger } from "@koi/core/pay-ledger";
import type { NexusPayLedgerConfig } from "./config.js";
import { createNexusPayLedger } from "./ledger.js";

/**
 * Adapt a PayLedger to the BudgetTracker interface.
 *
 * Note: sessionId is accepted for BudgetTracker compatibility but not
 * sent to Nexus (the agent is identified by API key).
 *
 * The `breakdown()` method returns aggregate cost from the ledger balance.
 * Per-model and per-tool granularity is not available from Nexus (agent-scoped),
 * so `byModel` and `byTool` are always empty.
 */
export function mapPayLedgerToBudgetTracker(ledger: PayLedger, budget: number): BudgetTracker {
  return {
    async record(_sessionId: string, entry: CostEntry): Promise<void> {
      await ledger.meter(entry.costUsd.toString(), "model_call");
    },

    async totalSpend(_sessionId: string): Promise<number> {
      const balance = await ledger.getBalance();
      return Math.max(0, budget - parseFloat(balance.available));
    },

    async remaining(_sessionId: string, _budget: number): Promise<number> {
      const balance = await ledger.getBalance();
      return Math.max(0, parseFloat(balance.available));
    },

    async breakdown(_sessionId: string): Promise<CostBreakdown> {
      const balance = await ledger.getBalance();
      return {
        totalCostUsd: Math.max(0, budget - parseFloat(balance.available)),
        byModel: [],
        byTool: [],
      };
    },
  };
}

/**
 * Convenience factory: creates a NexusPayLedger and wraps it as a BudgetTracker.
 */
export function createNexusBudgetTracker(
  config: NexusPayLedgerConfig & { readonly budget: number },
): BudgetTracker {
  const ledger = createNexusPayLedger(config);
  return mapPayLedgerToBudgetTracker(ledger, config.budget);
}
