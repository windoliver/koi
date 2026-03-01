/**
 * Composite SecurityAnalyzer: runs multiple analyzers in parallel and
 * takes the maximum risk level across all results.
 *
 * Total latency = slowest single analyzer (parallel execution via Promise.all).
 */

import type { RiskAnalysis, SecurityAnalyzer } from "@koi/core";
import { maxRiskLevel } from "./rules.js";

/**
 * Create a SecurityAnalyzer that delegates to all provided analyzers in
 * parallel and aggregates results by taking the maximum risk level.
 *
 * If analyzers is empty, returns riskLevel "low" with no findings.
 */
export function createCompositeSecurityAnalyzer(
  analyzers: readonly SecurityAnalyzer[],
): SecurityAnalyzer {
  return {
    async analyze(toolId, input, context): Promise<RiskAnalysis> {
      if (analyzers.length === 0) {
        return { riskLevel: "low", findings: [], rationale: "no analyzers configured" };
      }

      const results = await Promise.all(
        analyzers.map((a) => Promise.resolve(a.analyze(toolId, input, context))),
      );

      const allFindings = results.flatMap((r) => [...r.findings]);
      const riskLevel = maxRiskLevel(results.map((r) => r.riskLevel));

      return {
        riskLevel,
        findings: allFindings,
        rationale: `${analyzers.length} analyzer(s) evaluated: ${riskLevel}`,
      };
    },
  };
}
