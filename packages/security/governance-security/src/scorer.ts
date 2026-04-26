/**
 * Security scorer — composite 0-100 score from static analysis + anomaly signals.
 *
 * Weights:
 *   static_analysis: 0.6
 *   anomalies (total): 0.4, split equally across all detected anomalies
 *
 * Level thresholds:
 *   >=75 → critical
 *   >=50 → high
 *   >=20 → medium
 *   else  → low
 */

import type { AnomalySignal, RiskAnalysis, RiskLevel } from "@koi/core";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ScoreContribution {
  readonly source: string;
  readonly weight: number;
  readonly riskLevel: RiskLevel;
}

export interface SecurityScore {
  readonly score: number;
  readonly level: RiskLevel;
  readonly contributions: readonly ScoreContribution[];
}

export interface SecurityScorer {
  readonly score: (analysis: RiskAnalysis, anomalies: readonly AnomalySignal[]) => SecurityScore;
}

// ---------------------------------------------------------------------------
// Risk weight table
// ---------------------------------------------------------------------------

const RISK_WEIGHTS = {
  unknown: 0,
  low: 0,
  medium: 50,
  high: 75,
  critical: 100,
} as const satisfies Record<RiskLevel, number>;

const STATIC_WEIGHT = 0.6;
const ANOMALY_TOTAL_WEIGHT = 0.4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreToLevel(score: number): RiskLevel {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 20) return "medium";
  return "low";
}

function anomalyToRiskLevel(anomaly: AnomalySignal): RiskLevel {
  switch (anomaly.kind) {
    case "denied_tool_calls":
      return "high";
    case "irreversible_action_rate":
      return "critical";
    case "goal_drift":
      return "high";
    case "delegation_depth_exceeded":
      return "high";
    case "tool_rate_exceeded":
      return "high";
    case "error_spike":
      return "medium";
    case "tool_repeated":
      return "medium";
    case "model_latency_anomaly":
      return "low";
    case "token_spike":
      return "medium";
    case "tool_diversity_spike":
      return "medium";
    case "tool_ping_pong":
      return "medium";
    case "session_duration_exceeded":
      return "low";
    default: {
      // exhaustiveness guard — TypeScript should narrow this to `never`
      const _exhaustive: never = anomaly;
      void _exhaustive;
      return "medium";
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSecurityScorer(): SecurityScorer {
  return {
    score(analysis: RiskAnalysis, anomalies: readonly AnomalySignal[]): SecurityScore {
      const contributions: ScoreContribution[] = [];

      // Static analysis contribution
      const staticRisk = RISK_WEIGHTS[analysis.riskLevel];
      contributions.push({
        source: "static_analysis",
        weight: STATIC_WEIGHT,
        riskLevel: analysis.riskLevel,
      });

      let rawScore = staticRisk * STATIC_WEIGHT;

      // Anomaly contributions — split remaining 0.4 equally
      if (anomalies.length > 0) {
        const perAnomalyWeight = ANOMALY_TOTAL_WEIGHT / anomalies.length;
        for (const anomaly of anomalies) {
          const level = anomalyToRiskLevel(anomaly);
          const risk = RISK_WEIGHTS[level];
          contributions.push({
            source: `anomaly_${anomaly.kind}`,
            weight: perAnomalyWeight,
            riskLevel: level,
          });
          rawScore += risk * perAnomalyWeight;
        }
      }

      const score = Math.min(100, Math.max(0, Math.round(rawScore)));
      return {
        score,
        level: scoreToLevel(score),
        contributions,
      };
    },
  };
}
