/**
 * Public types for @koi/decision-ledger.
 *
 * See docs/L2/decision-ledger.md for semantics and the ordering caveat.
 */

import type { AuditEntry, AuditSink, KoiError, Result } from "@koi/core";
import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core/rich-trajectory";
import type { ReportStore, RunReport } from "@koi/core/run-report";

/**
 * Per-sink fetch outcome reported on the ledger response.
 *
 * The discriminant `state` is designed so that an exhaustive switch on it
 * cannot silently accept a trust-boundary failure:
 *
 * - `"present"` — clean fetch; lane has usable data and no leakage.
 * - `"present-with-leakage"` — lane has usable data AND the sink returned
 *   records for other sessions that were dropped. Callers MUST NOT alias
 *   this to `"present"` — it forces explicit acknowledgment of a partial
 *   trust-boundary failure. Records in the lane are safe to use.
 * - `"integrity-violation"` — strictly worse: the sink returned records
 *   and every one was for another session. Lane has no usable data.
 * - `"missing"` — sink legitimately returned zero records.
 * - `"unqueryable"` — sink absent or `.query` method missing.
 * - `"error"` — sink threw during the fetch.
 *
 * Callers that want to process records should branch on
 * `state === "present" || state === "present-with-leakage"` and — for the
 * leakage variant — alert on the attached `integrityFilteredCount`. A naive
 * `state === "present"` switch will miss leaky fetches, which is the
 * desired failure mode: the caller drops the records (no false-positive
 * rendering of compromised data) AND an exhaustive TS switch will flag
 * the unhandled branch at compile time.
 */
export type SourceStatus =
  | { readonly state: "present" }
  | {
      /**
       * Lane still has usable data but the sink returned records for other
       * sessions that were dropped. Forces explicit caller handling via the
       * distinct discriminant. See the union's doc comment above.
       */
      readonly state: "present-with-leakage";
      readonly integrityFilteredCount: number;
    }
  | {
      /**
       * Lane has records but the ledger CANNOT field-verify that they
       * belong to the requested session. Used exclusively for the
       * trajectory lane, which carries no `sessionId` on its records
       * (see `TrajectoryTrustModel`). Distinct from `present` so callers
       * cannot mistake unverifiable store output for verified data —
       * a naive `state === "present"` switch will NOT match. Records
       * are still returned because the `TrajectoryDocumentStore`'s
       * keying by `docId` is the session identity and the lane has
       * diagnostic value; the separate discriminant forces callers to
       * acknowledge the trust model of whatever store they're using.
       */
      readonly state: "present-unverified";
    }
  | { readonly state: "missing" }
  | {
      /**
       * Backend returned at least one record and ALL of them were dropped
       * by the session-integrity filter. Callers switching only on `state`
       * must handle this branch — do NOT alias it to `missing`.
       */
      readonly state: "integrity-violation";
      readonly integrityFilteredCount: number;
    }
  | { readonly state: "unqueryable" }
  | { readonly state: "error"; readonly error: KoiError };

/**
 * Per-sink counts of cross-session records that the ledger dropped for
 * session-integrity reasons — for sinks the ledger CAN structurally
 * re-validate.
 *
 * **Covers both partial leaks and full integrity violations.** The count
 * is the total number of records the sink returned that belonged to other
 * sessions, regardless of whether any matching records remained (partial
 * leak → `state: "present-with-leakage"`) or not (full violation → `state:
 * "integrity-violation"`). A flat top-level caller that only reads these
 * counts must alert on any non-zero value — it does not need to cross-
 * reference `sources.*.state`.
 *
 * **Trajectory is deliberately absent from this type.** `RichTrajectoryStep`
 * carries no `sessionId` field, so the ledger cannot field-verify trajectory
 * records against the requested session — the `TrajectoryDocumentStore`'s
 * keying by `docId` IS the session identity, and trust is store-authoritative.
 * A buggy/stale/over-broad trajectory store that returns records for the
 * wrong `docId` would be an undetected leak on the trajectory lane. Callers
 * who need stronger guarantees must use a trajectory store whose keying is
 * cryptographically scoped to the caller's session identity.
 *
 * Non-zero → trust-boundary failure; incident tooling should alert.
 */
export interface IntegrityLeakCounts {
  readonly audit: number;
  readonly report: number;
}

/**
 * Documents the trust model for the trajectory lane. Exported so callers
 * can name the contract in their own code and make the unverifiability
 * explicit at type boundaries. There is intentionally only one member —
 * this is not a discriminated union, it is a single pledge about the lane.
 */
export type TrajectoryTrustModel = "store-authoritative";

/** Status flags for all three sinks the ledger consults. */
export interface DecisionLedgerSources {
  readonly trajectory: SourceStatus;
  readonly audit: SourceStatus;
  readonly report: SourceStatus;
}

/**
 * Result of a per-session ledger query.
 *
 * Trajectory and audit records are exposed as separate lanes in their own
 * source-native ordering — trajectory steps in `stepIndex` order, audit entries
 * in ascending `timestamp` order. We deliberately do NOT interleave them into
 * a single timeline: without a shared causal key, a wall-clock merge can render
 * a decision audit entry on the wrong side of the step it governed. Callers
 * that need a combined display should merge with explicit awareness of that
 * caveat.
 */
export interface DecisionLedger {
  readonly sessionId: string;
  /**
   * Trajectory steps in `stepIndex` order. Trust is `trajectoryTrustModel`
   * (store-authoritative) — see that field for the caveat on trajectory
   * cross-session verification.
   */
  readonly trajectorySteps: readonly RichTrajectoryStep[];
  /** Audit entries for this session, ordered by `timestamp` ascending. */
  readonly auditEntries: readonly AuditEntry[];
  /** Latest run report for this session, when a ReportStore is configured. */
  readonly runReport?: RunReport | undefined;
  readonly sources: DecisionLedgerSources;
  /**
   * Top-level integrity counts for sinks the ledger CAN structurally
   * re-validate (audit, report). Covers BOTH partial leaks and full
   * violations — a flat caller that only reads these counts will see
   * any cross-session data exposure without having to inspect
   * `sources.*.state`.
   *
   * Callers MUST treat any non-zero value as a trust-boundary failure
   * and alert. Clean fetches have all counts at zero.
   *
   * Trajectory is NOT in this field — see `trajectoryTrustModel`.
   */
  readonly integrityLeakCounts: IntegrityLeakCounts;
  /**
   * Constant signal that trajectory lane trust is store-authoritative,
   * NOT field-verified. Present at type level so callers cannot mistake
   * the absence of trajectory from `integrityLeakCounts` for "verified
   * clean." Always `"store-authoritative"` — this field exists to make
   * the unverifiability explicit in the API surface.
   */
  readonly trajectoryTrustModel: TrajectoryTrustModel;
  /**
   * Flat boolean signal — always `false`.
   *
   * A caller that tries to shortcut integrity checks with
   * `if (integrityLeakCounts.audit === 0 && integrityLeakCounts.report === 0) trust()`
   * misses the fact that the trajectory lane is unverifiable at all.
   * This field exists specifically so that any caller writing
   * `if (ledger.allLanesFieldVerified) trust()` takes the `else` branch —
   * the honest answer is "no lane set is fully field-verified, because
   * RichTrajectoryStep has no sessionId and trajectory trust is
   * store-authoritative." The literal-`false` type makes this a compile-
   * time guarantee: the `true` branch is structurally dead code.
   *
   * A future schema that adds a verifiable session identifier to
   * trajectory records would widen this to `boolean` and enable real
   * field verification across all lanes.
   */
  readonly allLanesFieldVerified: false;
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
