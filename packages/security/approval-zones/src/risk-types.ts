/**
 * Risk tiers for approval-zone gating.
 * Ordering: low < medium < high < critical (use compareRisk to compare).
 */
export type RiskTier = "low" | "medium" | "high" | "critical";

export interface RiskInputs {
  readonly toolId: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly resource?: string | undefined;
  readonly bashCommand?: string | undefined;
}

export interface RiskAssessment {
  readonly tier: RiskTier;
  /** Human-readable reasons; surfaced in audit events. */
  readonly reasons: readonly string[];
}

export interface RiskScorer {
  score(inputs: RiskInputs): RiskAssessment | Promise<RiskAssessment>;
}

const RISK_ORDER: Readonly<Record<RiskTier, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Returns negative if a < b, zero if equal, positive if a > b. */
export function compareRisk(a: RiskTier, b: RiskTier): number {
  return RISK_ORDER[a] - RISK_ORDER[b];
}
