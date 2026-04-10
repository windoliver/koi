/**
 * Public types for @koi/decision-ledger.
 *
 * See docs/L2/decision-ledger.md for semantics and the ordering caveat.
 */

import type { AuditEntry, AuditSink, KoiError, Result } from "@koi/core";
import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core/rich-trajectory";
import type { ReportStore, RunReport } from "@koi/core/run-report";

/** A single entry in the decision ledger timeline. */
export type DecisionLedgerEntry =
  | {
      readonly kind: "trajectory-step";
      readonly timestamp: number;
      readonly stepIndex: number;
      readonly source: RichTrajectoryStep;
    }
  | {
      readonly kind: "audit";
      readonly timestamp: number;
      readonly turnIndex: number;
      readonly source: AuditEntry;
    };

/** Per-sink fetch outcome reported on the ledger response. */
export type SourceStatus =
  | { readonly state: "present" }
  | { readonly state: "missing" }
  | { readonly state: "unqueryable" }
  | { readonly state: "error"; readonly error: KoiError };

/** Status flags for all three sinks the ledger consults. */
export interface DecisionLedgerSources {
  readonly trajectory: SourceStatus;
  readonly audit: SourceStatus;
  readonly report: SourceStatus;
}

/** Result of a per-session ledger query. */
export interface DecisionLedger {
  readonly sessionId: string;
  readonly entries: readonly DecisionLedgerEntry[];
  readonly runReport?: RunReport | undefined;
  readonly sources: DecisionLedgerSources;
}

/** Read-only ledger API. */
export interface DecisionLedgerReader {
  readonly getLedger: (sessionId: string) => Promise<Result<DecisionLedger, KoiError>>;
}

/** Narrow trajectory dependency — we only read. */
export type TrajectoryReader = Pick<TrajectoryDocumentStore, "getDocument">;

/** Configuration for the ledger factory. */
export interface DecisionLedgerConfig {
  readonly trajectoryStore: TrajectoryReader;
  readonly auditSink?: AuditSink | undefined;
  readonly reportStore?: ReportStore | undefined;
}
