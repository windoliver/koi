/**
 * Types for the in-memory governance backend.
 *
 * Defines configuration, rules, evaluation context, and adaptive thresholds
 * for Cedar-inspired constraint DAG evaluation.
 */

import type {
  PolicyRequest,
  PolicyRequestKind,
  ViolationSeverity,
} from "@koi/core/governance-backend";

// ---------------------------------------------------------------------------
// AnomalySignalLike — minimal shape for anomaly bridge (avoids L2→L2 import)
// ---------------------------------------------------------------------------

/**
 * Minimal anomaly signal shape expected by the governance evaluator.
 * Compatible with @koi/agent-monitor AnomalySignal without importing it.
 */
export interface AnomalySignalLike {
  readonly kind: string;
  readonly sessionId: string;
}

// ---------------------------------------------------------------------------
// AdaptiveThresholdConfig
// ---------------------------------------------------------------------------

/** Configuration for an adaptive threshold that tightens on violations and relaxes on clean evals. */
export interface AdaptiveThresholdConfig {
  /** Base threshold value. */
  readonly baseValue: number;
  /** Multiplier applied on violation (< 1.0 tightens). Default: 0.9. */
  readonly decayRate: number;
  /** Multiplier applied on clean eval (> 1.0 relaxes). Default: 1.02. */
  readonly recoveryRate: number;
  /** Minimum allowed value. */
  readonly floor: number;
  /** Maximum allowed value. */
  readonly ceiling: number;
}

// ---------------------------------------------------------------------------
// EvaluationContext — enriched context passed to rule conditions
// ---------------------------------------------------------------------------

/** Enriched context available to rule condition functions during evaluation. */
export interface EvaluationContext {
  /** Count of recent anomalies for the requesting agent's session. */
  readonly anomalyCount: number;
  /** Recent anomaly signals from the agent monitor bridge. */
  readonly recentAnomalies: readonly AnomalySignalLike[];
  /** Current adaptive threshold values keyed by rule ID. */
  readonly adaptiveThresholds: ReadonlyMap<string, number>;
}

// ---------------------------------------------------------------------------
// GovernanceRule — a single policy rule in the constraint DAG
// ---------------------------------------------------------------------------

/** A single policy rule with optional DAG dependencies and scope filtering. */
export interface GovernanceRule {
  /** Unique rule identifier. */
  readonly id: string;
  /** Whether this rule permits or forbids matching requests. */
  readonly effect: "permit" | "forbid";
  /** Evaluation priority — lower numbers evaluated first. */
  readonly priority: number;
  /** Optional scope filter — rule only applies to these request kinds. */
  readonly scope?: readonly PolicyRequestKind[] | undefined;
  /** DAG edges — IDs of rules that must pass before this rule is evaluated. */
  readonly dependsOn?: readonly string[] | undefined;
  /** Condition function — returns true if the rule matches the request. */
  readonly condition: (request: PolicyRequest, context: EvaluationContext) => boolean;
  /** Human-readable violation message. */
  readonly message: string;
  /** Violation severity. Defaults to "critical" for forbid, "info" for permit. */
  readonly severity?: ViolationSeverity | undefined;
}

// ---------------------------------------------------------------------------
// GovernanceMemoryConfig — configuration for the in-memory backend
// ---------------------------------------------------------------------------

/** Configuration for creating an in-memory governance backend. */
export interface GovernanceMemoryConfig {
  /** Initial rule set for the constraint DAG. */
  readonly rules?: readonly GovernanceRule[] | undefined;
  /** Ring buffer capacity for compliance records. Default: 10_000. */
  readonly complianceCapacity?: number | undefined;
  /** Per-agent ring buffer capacity for violations. Default: 1_000. */
  readonly violationCapacity?: number | undefined;
  /** Bridge callback to fetch recent anomalies from agent monitor. Keyed by agent ID. Fail-open on error. */
  readonly getRecentAnomalies?: ((agentId: string) => readonly AnomalySignalLike[]) | undefined;
  /** Anomaly kinds that trigger severity elevation. */
  readonly elevateOnAnomalyKinds?: readonly string[] | undefined;
  /** Policy fingerprint for compliance records. */
  readonly policyFingerprint?: string | undefined;
  /** Adaptive threshold configs keyed by rule ID. */
  readonly adaptiveThresholds?: ReadonlyMap<string, AdaptiveThresholdConfig> | undefined;
}
