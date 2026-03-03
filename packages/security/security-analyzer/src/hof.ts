/**
 * withRiskAnalysis — Higher-Order Function that wraps an onAsk handler with
 * SecurityAnalyzer risk classification.
 *
 * Wiring:
 *   1. Run the SecurityAnalyzer with a configurable timeout (default 2000ms).
 *   2. If riskLevel === "critical" → auto-deny, onAsk never called.
 *   3. Otherwise → call onAsk with riskAnalysis attached to the request.
 *   4. Analyzer errors or timeouts → fail-open (riskLevel "unknown"), onAsk still runs.
 */

import type { JsonObject, RiskAnalysis, SecurityAnalyzer } from "@koi/core";
import { RISK_ANALYSIS_UNKNOWN } from "@koi/core";

export const DEFAULT_ANALYZER_TIMEOUT_MS = 2_000;

/**
 * Wraps an onAsk handler with risk analysis enrichment.
 *
 * @param analyzer - The SecurityAnalyzer to call before onAsk.
 * @param onAsk - The original handler to call with riskAnalysis attached.
 * @param timeoutMs - Max time (ms) to wait for the analyzer. Defaults to 2000.
 * @returns A new handler with the same signature as onAsk's request type.
 */
export function withRiskAnalysis<
  TRequest extends { readonly toolId: string; readonly input: JsonObject },
  TDecision,
>(
  analyzer: SecurityAnalyzer,
  onAsk: (req: TRequest & { readonly riskAnalysis: RiskAnalysis }) => Promise<TDecision>,
  timeoutMs: number = DEFAULT_ANALYZER_TIMEOUT_MS,
): (req: TRequest) => Promise<TDecision> {
  return async (req: TRequest): Promise<TDecision> => {
    let analysis: RiskAnalysis = RISK_ANALYSIS_UNKNOWN;

    try {
      analysis = await Promise.race([
        Promise.resolve(analyzer.analyze(req.toolId, req.input)),
        new Promise<RiskAnalysis>((resolve) => {
          const timer = setTimeout(() => resolve(RISK_ANALYSIS_UNKNOWN), timeoutMs);
          // Allow the timer to be garbage-collected if the race resolves first
          if (typeof timer === "object" && "unref" in timer) {
            (timer as { unref(): void }).unref();
          }
        }),
      ]);
    } catch {
      // fail-open: analyzer threw → use unknown risk, onAsk still runs
      analysis = RISK_ANALYSIS_UNKNOWN;
    }

    if (analysis.riskLevel === "critical") {
      // Auto-deny: never call onAsk for critical risk
      // We cast here because TDecision must be compatible with a deny response.
      // Callers are expected to use ProgressiveDecision or a similar discriminated union.
      return { kind: "deny_once", reason: `Critical risk: ${analysis.rationale}` } as TDecision;
    }

    return onAsk({ ...req, riskAnalysis: analysis });
  };
}
