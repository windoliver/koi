// Public surface for @koi/decision-ledger.
// Per CLAUDE.md: no barrel re-exports at scale — only the factory + public types.

export { createDecisionLedger, LEDGER_SOFT_CEILING } from "./create-decision-ledger.js";
export type {
  DecisionLedger,
  DecisionLedgerConfig,
  DecisionLedgerReader,
  DecisionLedgerSources,
  IntegrityLeakCounts,
  SourceStatus,
  TrajectoryReader,
  TrajectoryTrustModel,
} from "./types.js";
