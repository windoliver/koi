/**
 * Per-sink record normalization — wraps raw sink records into DecisionLedgerEntry
 * variants with `timestamp` hoisted to the top level for sort efficiency.
 */

import type { AuditEntry } from "@koi/core";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import type { DecisionLedgerEntry } from "./types.js";

export function wrapTrajectoryStep(step: RichTrajectoryStep): DecisionLedgerEntry {
  return {
    kind: "trajectory-step",
    timestamp: step.timestamp,
    stepIndex: step.stepIndex,
    source: step,
  };
}

export function wrapAuditEntry(entry: AuditEntry): DecisionLedgerEntry {
  return {
    kind: "audit",
    timestamp: entry.timestamp,
    turnIndex: entry.turnIndex,
    source: entry,
  };
}
