/**
 * createDecisionLedger — factory that returns a DecisionLedgerReader.
 *
 * See docs/L2/decision-ledger.md for the full contract. This file wires the
 * pure fetch helpers into the public interface. Trajectory and audit are
 * exposed as separate lanes, each in source-native order, rather than merged
 * on wall-clock timestamp — see the ordering discussion in the doc.
 */

import type { KoiError, Result } from "@koi/core";
import { internalError, validationError } from "./errors.js";
import { fetchAudit, fetchReport, fetchTrajectory } from "./fetch-sources.js";
import type { DecisionLedger, DecisionLedgerConfig, DecisionLedgerReader } from "./types.js";

/**
 * Soft ceiling for combined ledger size. Above this we log a warning but
 * still return the full lanes — pagination is explicitly out of scope for
 * Phase 2(a). Used as an observability signal for incident triage so
 * oversized responses don't silently cause UI slowdowns or memory pressure.
 */
export const LEDGER_SOFT_CEILING = 50_000;

export function createDecisionLedger(config: DecisionLedgerConfig): DecisionLedgerReader {
  return {
    getLedger: (sessionId) => getLedgerImpl(config, sessionId),
  };
}

async function getLedgerImpl(
  config: DecisionLedgerConfig,
  sessionId: string,
): Promise<Result<DecisionLedger, KoiError>> {
  if (sessionId.length === 0) {
    return { ok: false, error: validationError("sessionId must not be empty") };
  }

  try {
    const [trajectory, audit, report] = await Promise.all([
      fetchTrajectory(config.trajectoryStore, sessionId),
      fetchAudit(config.auditSink, sessionId),
      fetchReport(config.reportStore, sessionId),
    ]);

    // Ceiling is checked against RAW sink response sizes (before integrity
    // filtering), not the final lane sizes. A buggy sink returning 100k
    // wrong-session records with only a handful matching still costs memory
    // and time to load and filter; the warning must fire on that path.
    const rawCombinedSize = trajectory.rawCount + audit.rawCount + report.rawCount;
    if (rawCombinedSize > LEDGER_SOFT_CEILING) {
      console.warn(
        `[decision-ledger] session "${sessionId}" raw sink response size ${rawCombinedSize} exceeds soft ceiling ${LEDGER_SOFT_CEILING}; callers should consider filtering — pagination is out of scope for Phase 2(a)`,
      );
    }

    const ledger: DecisionLedger = {
      sessionId,
      trajectorySteps: trajectory.records,
      auditEntries: audit.records,
      runReport: report.latest,
      sources: {
        trajectory: trajectory.status,
        audit: audit.status,
        report: report.status,
      },
      integrityLeakCounts: {
        audit: audit.integrityFilteredCount,
        report: report.integrityFilteredCount,
      },
      trajectoryTrustModel: "store-authoritative",
      allLanesFieldVerified: false,
    };
    return { ok: true, value: ledger };
  } catch (cause) {
    return {
      ok: false,
      error: internalError("decision-ledger internal failure", cause),
    };
  }
}
