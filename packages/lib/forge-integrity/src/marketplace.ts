import type { BrickArtifact, SigningBackend } from "@koi/core";
import type {
  InstallProvenanceResult,
  VerifyInstallProvenanceOptions,
} from "./install-verification.js";
import { verifyInstallProvenance } from "./install-verification.js";
import type { BrickVerifier } from "./integrity.js";
import { computeTrustScore, type TrustScoreResult } from "./trust-score.js";
import type { VirusTotalSignal } from "./virustotal.js";

export type MarketplaceDecision = "accepted" | "warning" | "blocked";

export interface LocalScanSignal {
  readonly passed: boolean;
  readonly score: number;
}

export interface CommunityTrustSignal {
  readonly score: number;
  readonly feedbackCount: number;
}

export interface PublisherIdentityResult {
  readonly verified: boolean;
  readonly publisherId: string;
}

export interface PublisherIdentityVerifier {
  readonly verifyPublisher: (
    brick: BrickArtifact,
  ) => PublisherIdentityResult | Promise<PublisherIdentityResult>;
}

export interface EvaluateMarketplaceTrustOptions {
  readonly expectedBuilderId: string;
  readonly verifier: BrickVerifier;
  readonly signer: SigningBackend;
  readonly attestation?: VerifyInstallProvenanceOptions["attestation"];
  readonly localScan: LocalScanSignal;
  readonly virusTotal: Pick<VirusTotalSignal, "passed" | "verdict" | "score">;
  readonly publisherVerifier:
    | PublisherIdentityVerifier
    | ((brick: BrickArtifact) => PublisherIdentityResult | Promise<PublisherIdentityResult>);
  readonly community: CommunityTrustSignal;
}

export interface MarketplaceTrustResult {
  readonly decision: MarketplaceDecision;
  readonly install: InstallProvenanceResult;
  readonly publisher: PublisherIdentityResult;
  readonly trust: TrustScoreResult;
  readonly reasons: readonly string[];
}

async function verifyPublisher(
  brick: BrickArtifact,
  verifier: EvaluateMarketplaceTrustOptions["publisherVerifier"],
): Promise<PublisherIdentityResult> {
  if (typeof verifier === "function") return verifier(brick);
  return verifier.verifyPublisher(brick);
}

function installReason(result: InstallProvenanceResult): string | undefined {
  if (result.ok) return undefined;
  if (result.kind === "integrity_failed") return `integrity_failed:${result.integrity.kind}`;
  return `attestation_failed:${result.attestation.kind}`;
}

export async function evaluateMarketplaceTrust(
  brick: BrickArtifact,
  options: EvaluateMarketplaceTrustOptions,
): Promise<MarketplaceTrustResult> {
  const install = await verifyInstallProvenance(brick, {
    expectedBuilderId: options.expectedBuilderId,
    verifier: options.verifier,
    signer: options.signer,
    attestation: options.attestation,
  });
  const publisher = await verifyPublisher(brick, options.publisherVerifier);
  const trust = computeTrustScore({
    provenance: {
      verified: install.ok,
      expired: install.kind === "attestation_failed" && install.attestation.kind === "expired",
    },
    localScan: options.localScan,
    virusTotal: options.virusTotal,
    publisher: { verified: publisher.verified },
    community: options.community,
  });

  const reasons = [
    installReason(install),
    options.localScan.passed ? undefined : "local_scan_failed",
    options.virusTotal.verdict === "malicious" ? "virustotal_malicious" : undefined,
    publisher.verified ? undefined : "publisher_unverified",
    trust.level === "blocked" ? "trust_score_blocked" : undefined,
  ].filter((reason): reason is string => reason !== undefined);

  return {
    decision: reasons.length > 0 ? "blocked" : trust.level === "low" ? "warning" : "accepted",
    install,
    publisher,
    trust,
    reasons,
  };
}
