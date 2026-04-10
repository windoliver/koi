// Public surface for @koi/decision-ledger.
// Per CLAUDE.md: no barrel re-exports at scale — only the factory + public types.

export { createDecisionLedger } from "./create-decision-ledger.js";
export type {
  DecisionLedger,
  DecisionLedgerConfig,
  DecisionLedgerEntry,
  DecisionLedgerReader,
  DecisionLedgerSources,
  SourceStatus,
  TrajectoryReader,
} from "./types.js";
