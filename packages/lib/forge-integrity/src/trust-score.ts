import type { VirusTotalSignal } from "./virustotal.js";

export type TrustScoreLevel = "blocked" | "low" | "medium" | "high" | "verified";

export interface TrustScoreInput {
  readonly provenance: {
    readonly verified: boolean;
    readonly expired: boolean;
  };
  readonly localScan: {
    readonly passed: boolean;
    readonly score: number;
  };
  readonly virusTotal: Pick<VirusTotalSignal, "passed" | "verdict" | "score">;
  readonly publisher: {
    readonly verified: boolean;
  };
  readonly community: {
    readonly score: number;
    readonly feedbackCount: number;
  };
}

export interface TrustScoreResult {
  readonly score: number;
  readonly level: TrustScoreLevel;
  readonly signals: {
    readonly provenance: "verified" | "missing" | "expired";
    readonly localScan: "passed" | "failed";
    readonly virusTotal: VirusTotalSignal["verdict"];
    readonly publisherIdentity: "verified" | "unverified";
    readonly communityFeedback: "none" | "present";
  };
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, score));
}

function levelFor(score: number): TrustScoreLevel {
  if (score < 30) return "blocked";
  if (score < 50) return "low";
  if (score < 75) return "medium";
  if (score < 90) return "high";
  return "verified";
}

export function computeTrustScore(input: TrustScoreInput): TrustScoreResult {
  const provenanceScore = input.provenance.expired ? 0 : input.provenance.verified ? 100 : 20;
  const localScanScore = input.localScan.passed ? clampScore(input.localScan.score) : 0;
  const vtScore = input.virusTotal.passed ? clampScore(input.virusTotal.score) : 0;
  const publisherScore = input.publisher.verified ? 100 : 40;
  const communityScore =
    input.community.feedbackCount > 0 ? clampScore(input.community.score * 100) : 50;
  const score = Math.round(
    provenanceScore * 0.3 +
      localScanScore * 0.2 +
      vtScore * 0.2 +
      publisherScore * 0.15 +
      communityScore * 0.15,
  );
  const forcedBlocked =
    input.provenance.expired || !input.localScan.passed || input.virusTotal.verdict === "malicious";
  const effectiveScore = forcedBlocked ? Math.min(score, 29) : score;
  return {
    score: effectiveScore,
    level: levelFor(effectiveScore),
    signals: {
      provenance: input.provenance.expired
        ? "expired"
        : input.provenance.verified
          ? "verified"
          : "missing",
      localScan: input.localScan.passed ? "passed" : "failed",
      virusTotal: input.virusTotal.verdict,
      publisherIdentity: input.publisher.verified ? "verified" : "unverified",
      communityFeedback: input.community.feedbackCount > 0 ? "present" : "none",
    },
  };
}
