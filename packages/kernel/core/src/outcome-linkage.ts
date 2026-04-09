/**
 * Outcome linkage types — connect agent decisions to downstream business results (Layer 0).
 *
 * Provides correlation infrastructure for external systems to report outcomes
 * against specific decisions identified by DecisionCorrelationId.
 *
 * Format-agnostic: no ATIF concepts. ATIF document linkage is handled in runtime.
 */

import type { JsonObject } from "./common.js";

// ---------------------------------------------------------------------------
// Branded correlation ID
// ---------------------------------------------------------------------------

declare const __decisionCorrelationBrand: unique symbol;

/**
 * Branded string type for decision correlation identifiers.
 * Used to link agent decisions to downstream business outcomes.
 */
export type DecisionCorrelationId = string & {
  readonly [__decisionCorrelationBrand]: "DecisionCorrelationId";
};

/** Create a branded DecisionCorrelationId from a plain string. */
export function decisionCorrelationId(id: string): DecisionCorrelationId {
  return id as DecisionCorrelationId;
}

// ---------------------------------------------------------------------------
// Outcome types
// ---------------------------------------------------------------------------

/** Business outcome valence reported by external systems. */
export type OutcomeValence = "positive" | "negative" | "neutral" | "mixed";

/**
 * A reported business outcome linked to a decision via correlation ID.
 *
 * Written by external systems (or the future `report_outcome` tool) to
 * record what happened as a result of an agent decision.
 */
export interface OutcomeReport {
  /** The decision this outcome is linked to. */
  readonly correlationId: DecisionCorrelationId;
  /** Business outcome valence. */
  readonly outcome: OutcomeValence;
  /** Domain-specific KPI metrics (e.g., revenue, resolution time). */
  readonly metrics: Readonly<Record<string, number>>;
  /** Human-readable description of the outcome. */
  readonly description: string;
  /** Identity of who reported this outcome. */
  readonly reportedBy: string;
  /** Timestamp when the outcome was reported (ms since epoch). */
  readonly timestamp: number;
  /** Opaque extension data for domain-specific fields. */
  readonly metadata?: JsonObject | undefined;
}

/**
 * Input for reporting an outcome (before persistence adds internal fields).
 * The `correlationId` is a plain string here — callers are responsible for
 * providing a valid ID that matches a `decisionCorrelationId` on a trajectory step.
 */
export interface OutcomeReportInput {
  /** Plain string correlation ID (will be branded on persistence). */
  readonly correlationId: string;
  /** Business outcome valence. */
  readonly outcome: OutcomeValence;
  /** Domain-specific KPI metrics. */
  readonly metrics: Readonly<Record<string, number>>;
  /** Human-readable description. */
  readonly description: string;
  /** Identity of who reported this outcome. */
  readonly reportedBy: string;
}

// ---------------------------------------------------------------------------
// Persistence contract
// ---------------------------------------------------------------------------

/**
 * Persistence backend for outcome reports.
 *
 * MVP surface: put + get only. Enumeration and deletion deferred until
 * a concrete consumer needs them.
 */
export interface OutcomeStore {
  /** Write an outcome report. Overwrites any existing report for the same correlation ID. */
  readonly put: (report: OutcomeReport) => Promise<void>;
  /** Get an outcome by correlation ID. Returns undefined if not found. */
  readonly get: (correlationId: string) => Promise<OutcomeReport | undefined>;
}
