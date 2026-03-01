/**
 * Monitor-bridge SecurityAnalyzer adapter.
 *
 * Wraps an existing SecurityAnalyzer and elevates risk level when the
 * agent-monitor has detected anomalies for the current session. The bridge
 * is decoupled from @koi/agent-monitor via a callback — callers supply
 * the getRecentAnomalies function, avoiding L2-to-L2 coupling.
 *
 * Fail-open: if the callback throws, the base analysis is returned unchanged.
 */

import type { JsonObject, RiskAnalysis, SecurityAnalyzer } from "@koi/core";
import { maxRiskLevel } from "./rules.js";

/**
 * Minimal anomaly signal shape expected by the bridge.
 * Compatible with @koi/agent-monitor AnomalySignal without importing it.
 */
export interface AnomalySignalLike {
  readonly kind: string;
  readonly sessionId: string;
}

export interface MonitorBridgeConfig {
  /** The underlying analyzer to delegate to. */
  readonly wrapped: SecurityAnalyzer;
  /**
   * Callback to retrieve recent anomaly signals for a session.
   * Typically delegates to an AgentMonitor instance.
   * Must be synchronous — called inline during analyze().
   */
  readonly getRecentAnomalies: (sessionId: string) => readonly AnomalySignalLike[];
  /**
   * Which anomaly kinds trigger risk elevation.
   * If omitted, all anomaly kinds trigger elevation.
   */
  readonly elevateOnAnomalyKinds?: readonly string[];
}

/**
 * Create a SecurityAnalyzer that elevates risk when agent-monitor anomalies
 * are present for the current session.
 *
 * Elevation: anomalies present → riskLevel becomes at least "high".
 * If the base analysis is already "critical", it stays "critical".
 */
export function createMonitorBridgeAnalyzer(config: MonitorBridgeConfig): SecurityAnalyzer {
  return {
    async analyze(toolId: string, input: JsonObject, context?: JsonObject): Promise<RiskAnalysis> {
      const base = await Promise.resolve(config.wrapped.analyze(toolId, input, context));

      const sessionId = context?.sessionId;
      if (typeof sessionId !== "string") {
        return base;
      }

      let anomalies: readonly AnomalySignalLike[] = [];
      try {
        anomalies = config.getRecentAnomalies(sessionId);
      } catch {
        // fail-open: callback error → return base analysis unchanged
        return base;
      }

      // Filter by kind if elevateOnAnomalyKinds is specified
      const relevant =
        config.elevateOnAnomalyKinds !== undefined
          ? anomalies.filter((a) => config.elevateOnAnomalyKinds?.includes(a.kind))
          : anomalies;

      if (relevant.length === 0) {
        return base;
      }

      // Elevate: take max of base level and "high"
      const elevated = maxRiskLevel([base.riskLevel, "high"]);

      return {
        riskLevel: elevated,
        findings: [
          ...base.findings,
          {
            pattern: "monitor:anomaly",
            description: `${relevant.length} recent anomaly signal(s) detected by agent-monitor`,
            riskLevel: "high",
          },
        ],
        rationale: `${base.rationale} + ${relevant.length} anomaly signal(s)`,
      };
    },
  };
}
