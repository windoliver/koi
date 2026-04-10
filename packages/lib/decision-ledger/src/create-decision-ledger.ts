/**
 * createDecisionLedger — factory that returns a DecisionLedgerReader.
 *
 * See docs/L2/decision-ledger.md for the full contract. This file wires the
 * pure fetch/normalize/join helpers into the public interface.
 */

import type { KoiError, Result } from "@koi/core";
import { internalError, validationError } from "./errors.js";
import { fetchAudit, fetchReport, fetchTrajectory } from "./fetch-sources.js";
import { mergeTimeline } from "./join.js";
import { wrapAuditEntry, wrapTrajectoryStep } from "./normalize.js";
import type { DecisionLedger, DecisionLedgerConfig, DecisionLedgerReader } from "./types.js";

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

    const trajectoryEntries = trajectory.records.map(wrapTrajectoryStep);
    const auditEntries = audit.records.map(wrapAuditEntry);
    const entries = mergeTimeline(trajectoryEntries, auditEntries);

    const ledger: DecisionLedger = {
      sessionId,
      entries,
      runReport: report.latest,
      sources: {
        trajectory: trajectory.status,
        audit: audit.status,
        report: report.status,
      },
    };
    return { ok: true, value: ledger };
  } catch (cause) {
    return {
      ok: false,
      error: internalError("decision-ledger internal failure", cause),
    };
  }
}
