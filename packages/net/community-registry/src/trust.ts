import type { MarketplaceSecurityFinding, TrustScoreInput } from "./types.js";

const SECURITY_PENALTY: Readonly<Record<MarketplaceSecurityFinding["severity"], number>> = {
  CRITICAL: 35,
  HIGH: 20,
  MEDIUM: 10,
  LOW: 3,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeDownloadScore(downloads: number): number {
  if (downloads <= 0) return 0;
  return clamp(Math.log10(downloads + 1) / 4, 0, 1) * 30;
}

function computeRatingScore(rating: number | undefined): number {
  if (rating === undefined) return 12;
  return (clamp(rating, 0, 5) / 5) * 25;
}

function computePublisherScore(reputation: number | undefined): number {
  if (reputation === undefined) return 15;
  return clamp(reputation, 0, 1) * 25;
}

function computeSecurityPenalty(
  findings: readonly MarketplaceSecurityFinding[] | undefined,
): number {
  if (findings === undefined) return 0;
  return findings.reduce((sum, finding) => sum + (SECURITY_PENALTY[finding.severity] ?? 0), 0);
}

export function computeMarketplaceTrustScore(input: TrustScoreInput): number {
  const downloads = input.downloads ?? 0;
  const raw =
    20 +
    computeDownloadScore(downloads) +
    computeRatingScore(input.rating) +
    computePublisherScore(input.publisherReputation) -
    computeSecurityPenalty(input.securityFindings);

  return Math.round(clamp(raw, 0, 100));
}
