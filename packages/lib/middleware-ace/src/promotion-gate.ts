/**
 * Pure promotion-gate evaluation for ACE proposal/evaluation pairs.
 */

import type {
  PlaybookEvaluation,
  PlaybookProposal,
  PromotionThresholds,
} from "@koi/ace-types";

function assertNonEmptyId(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function readNumberMetric(
  metrics: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asMetricRecord(metrics: PlaybookEvaluation["metrics"] | null | undefined):
  | Readonly<Record<string, unknown>>
  | undefined {
  if (metrics === null || metrics === undefined) return undefined;
  if (typeof metrics !== "object") return undefined;
  return metrics as Readonly<Record<string, unknown>>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function areValidThresholds(thresholds: PromotionThresholds): boolean {
  if (!isFiniteNumber(thresholds.minHelpfulRate)) return false;
  if (!isFiniteNumber(thresholds.maxHarmfulRate)) return false;
  if (!isFiniteNumber(thresholds.minTrials)) return false;
  if (thresholds.maxTokenDelta !== undefined && !isFiniteNumber(thresholds.maxTokenDelta)) {
    return false;
  }
  return true;
}

export async function evaluatePromotion(
  proposal: PlaybookProposal,
  evaluation: PlaybookEvaluation,
  thresholds: PromotionThresholds,
): Promise<"promote" | "reject" | "rollback"> {
  if (!areValidThresholds(thresholds)) {
    return "reject";
  }

  assertNonEmptyId(proposal.id, "proposal.id");
  assertNonEmptyId(evaluation.id, "evaluation.id");
  assertNonEmptyId(evaluation.proposalId, "evaluation.proposalId");

  if (evaluation.proposalId !== proposal.id) {
    throw new Error("evaluation.proposalId must match proposal.id");
  }

  if (evaluation.verdict === "reject") {
    return "reject";
  }

  if (evaluation.verdict === "rollback") {
    return "rollback";
  }

  if (evaluation.verdict !== "promote") {
    return "reject";
  }

  const metrics = asMetricRecord(evaluation.metrics);
  if (metrics === undefined) {
    return "reject";
  }

  const helpfulRate = readNumberMetric(metrics, "helpfulRate");
  const harmfulRate = readNumberMetric(metrics, "harmfulRate");
  const trials = readNumberMetric(metrics, "trials");

  if (helpfulRate === undefined || harmfulRate === undefined || trials === undefined) {
    return "reject";
  }

  if (helpfulRate < thresholds.minHelpfulRate) {
    return "reject";
  }

  if (harmfulRate > thresholds.maxHarmfulRate) {
    return "reject";
  }

  if (trials < thresholds.minTrials) {
    return "reject";
  }

  if (thresholds.maxTokenDelta !== undefined) {
    const tokenDelta = readNumberMetric(metrics, "tokenDelta");
    if (tokenDelta === undefined || tokenDelta > thresholds.maxTokenDelta) {
      return "reject";
    }
  }

  return "promote";
}
