/**
 * Timeline join — stable sort of trajectory + audit entries by wall-clock timestamp.
 *
 * Stability is guaranteed by ES2019's Array.prototype.sort contract, which Bun honors.
 * Callers that need causal ordering should look at decisionCorrelationId metadata
 * on trajectory steps instead — see docs/L2/decision-ledger.md.
 */

import type { DecisionLedgerEntry } from "./types.js";

/**
 * Soft ceiling for ledger size. Above this we log a warning but still return
 * the full ledger — pagination is explicitly out of scope for Phase 2(a).
 */
export const LEDGER_SOFT_CEILING = 50_000;

export function mergeTimeline(
  trajectoryEntries: readonly DecisionLedgerEntry[],
  auditEntries: readonly DecisionLedgerEntry[],
): readonly DecisionLedgerEntry[] {
  const combined: DecisionLedgerEntry[] = [];
  // Trajectory first so it wins ties via stable sort — matches the documented
  // convention in docs/L2/decision-ledger.md.
  for (const entry of trajectoryEntries) {
    combined.push(entry);
  }
  for (const entry of auditEntries) {
    combined.push(entry);
  }
  combined.sort((a, b) => a.timestamp - b.timestamp);
  if (combined.length > LEDGER_SOFT_CEILING) {
    console.warn(
      `[decision-ledger] ledger size ${combined.length} exceeds soft ceiling ${LEDGER_SOFT_CEILING}; callers should consider filtering`,
    );
  }
  return combined;
}
