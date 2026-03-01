/**
 * SecurityAnalyzer — dynamic risk classification contract (Layer 0).
 *
 * Evaluates a tool call and assigns a RiskLevel. Plugs into @koi/exec-approvals
 * and @koi/middleware-permissions via the withRiskAnalysis HOF in
 * @koi/security-analyzer.
 *
 * Zero dependencies — types only.
 */

import type { JsonObject } from "./common.js";

/**
 * Ordered risk levels from least to most severe.
 * "unknown" means the analyzer errored or was unavailable (fail-open).
 */
export type RiskLevel = "low" | "medium" | "high" | "critical" | "unknown";

/**
 * Canonical ordering of RiskLevel from least to most severe.
 * Use maxRiskLevel() from @koi/security-analyzer to compare levels.
 */
export const RISK_LEVEL_ORDER: readonly RiskLevel[] = [
  "unknown",
  "low",
  "medium",
  "high",
  "critical",
];

/**
 * A single matched pattern and its associated risk classification.
 */
export interface RiskFinding {
  /** The raw pattern string that matched, e.g. "rm -rf". */
  readonly pattern: string;
  /** Human-readable explanation of why this is risky. */
  readonly description: string;
  /** Risk level assigned to this specific finding. */
  readonly riskLevel: RiskLevel;
}

/**
 * Aggregated result from a SecurityAnalyzer.analyze() call.
 */
export interface RiskAnalysis {
  /** Maximum risk level across all findings. */
  readonly riskLevel: RiskLevel;
  /** All individual findings that contributed to riskLevel. */
  readonly findings: readonly RiskFinding[];
  /** Human-readable summary for display in approval prompts. */
  readonly rationale: string;
}

/**
 * Sentinel value used when an analyzer errors or times out (fail-open).
 * onAsk still runs when this value is returned.
 */
export const RISK_ANALYSIS_UNKNOWN: RiskAnalysis = Object.freeze({
  riskLevel: "unknown" as const,
  findings: Object.freeze([]) as readonly RiskFinding[],
  rationale: "analyzer error or unavailable",
});

/**
 * Pluggable risk classification contract.
 *
 * Implementations may be synchronous (rules-based) or asynchronous (LLM-based,
 * remote API, etc.). Return type is `RiskAnalysis | Promise<RiskAnalysis>` per
 * Koi I/O-bound interface convention — callers must always await.
 *
 * Analyzer errors must NOT propagate to callers; use the withRiskAnalysis HOF
 * from @koi/security-analyzer which enforces fail-open semantics.
 */
export interface SecurityAnalyzer {
  readonly analyze: (
    toolId: string,
    input: JsonObject,
    /** Optional session/turn metadata (sessionId, agentId, turnIndex, etc.) */
    context?: JsonObject,
  ) => RiskAnalysis | Promise<RiskAnalysis>;
}
