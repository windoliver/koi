/**
 * PayLedger → BudgetTracker adapter.
 *
 * Bridges the PayLedger contract (Nexus credit ledger) to the
 * BudgetTracker interface used by @koi/middleware-pay.
 *
 * Smart adapter: uses meter() for recording and getBalance() for queries,
 * keeping HTTP calls to 1 per operation.
 */

import type { PayLedger } from "@koi/core/pay-ledger";
import type { NexusPayLedgerConfig } from "./config.js";
import { createNexusPayLedger } from "./ledger.js";

// Re-declare minimal BudgetTracker shape to avoid importing from L2 peer.
// TODO: Promote BudgetTracker to L0 (@koi/core) so both packages share one contract.
// This matches @koi/middleware-pay's BudgetTracker exactly.
interface BudgetTracker {
  readonly record: (sessionId: string, entry: { readonly costUsd: number }) => Promise<void>;
  readonly totalSpend: (sessionId: string) => Promise<number>;
  readonly remaining: (sessionId: string, budget: number) => Promise<number>;
}

/**
 * Adapt a PayLedger to the BudgetTracker interface.
 *
 * Note: sessionId is accepted for BudgetTracker compatibility but not
 * sent to Nexus (the agent is identified by API key).
 */
export function mapPayLedgerToBudgetTracker(ledger: PayLedger, budget: number): BudgetTracker {
  return {
    async record(_sessionId: string, entry: { readonly costUsd: number }): Promise<void> {
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
