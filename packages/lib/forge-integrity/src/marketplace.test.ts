import { describe, expect, test } from "bun:test";
import type { BrickArtifact, SigningBackend } from "@koi/core";
import { createHmacSigner } from "@koi/hash";
import { makeTool, recomputeFixtureId } from "./__tests__/fixtures.js";
import { signAttestation } from "./attestation.js";
import { createBrickVerifier } from "./integrity.js";
import { evaluateMarketplaceTrust } from "./marketplace.js";

const TRUSTED_BUILDER = "koi/forge";
const signer: SigningBackend = createHmacSigner(new TextEncoder().encode("secret"));
const verifier = createBrickVerifier({ [TRUSTED_BUILDER]: recomputeFixtureId });

async function signedTool(): Promise<BrickArtifact> {
  const brick = makeTool();
  return { ...brick, provenance: await signAttestation(brick.provenance, signer) };
}

describe("marketplace trust evaluation", () => {
  test("accepts a signed brick with clean scans and verified publisher", async () => {
    const result = await evaluateMarketplaceTrust(await signedTool(), {
      expectedBuilderId: TRUSTED_BUILDER,
      verifier,
      signer,
      localScan: { passed: true, score: 95 },
      virusTotal: { passed: true, verdict: "clean", score: 100 },
      publisherVerifier: async () => ({ verified: true, publisherId: "publisher:koi" }),
      community: { score: 0.8, feedbackCount: 10 },
    });

    expect(result.decision).toBe("accepted");
    expect(result.trust.level).toBe("verified");
    expect(result.publisher.verified).toBe(true);
  });

  test("blocks publication when provenance attestation is missing", async () => {
    const result = await evaluateMarketplaceTrust(makeTool(), {
      expectedBuilderId: TRUSTED_BUILDER,
      verifier,
      signer,
      localScan: { passed: true, score: 95 },
      virusTotal: { passed: true, verdict: "clean", score: 100 },
      publisherVerifier: async () => ({ verified: true, publisherId: "publisher:koi" }),
      community: { score: 0.8, feedbackCount: 10 },
    });

    expect(result.decision).toBe("blocked");
    expect(result.reasons).toContain("attestation_failed:missing_attestation");
  });

  test("blocks publication when publisher identity is not verified", async () => {
    const result = await evaluateMarketplaceTrust(await signedTool(), {
      expectedBuilderId: TRUSTED_BUILDER,
      verifier,
      signer,
      localScan: { passed: true, score: 95 },
      virusTotal: { passed: true, verdict: "clean", score: 100 },
      publisherVerifier: async () => ({ verified: false, publisherId: "publisher:unknown" }),
      community: { score: 0.8, feedbackCount: 10 },
    });

    expect(result.decision).toBe("blocked");
    expect(result.reasons).toContain("publisher_unverified");
  });

  test("blocks publication when VirusTotal reports malicious code", async () => {
    const result = await evaluateMarketplaceTrust(await signedTool(), {
      expectedBuilderId: TRUSTED_BUILDER,
      verifier,
      signer,
      localScan: { passed: true, score: 95 },
      virusTotal: { passed: false, verdict: "malicious", score: 0 },
      publisherVerifier: async () => ({ verified: true, publisherId: "publisher:koi" }),
      community: { score: 0.8, feedbackCount: 10 },
    });

    expect(result.decision).toBe("blocked");
    expect(result.reasons).toContain("virustotal_malicious");
  });

  test("blocks publication when local scanner rejects code", async () => {
    const result = await evaluateMarketplaceTrust(await signedTool(), {
      expectedBuilderId: TRUSTED_BUILDER,
      verifier,
      signer,
      localScan: { passed: false, score: 10 },
      virusTotal: { passed: true, verdict: "clean", score: 100 },
      publisherVerifier: async () => ({ verified: true, publisherId: "publisher:koi" }),
      community: { score: 0.8, feedbackCount: 10 },
    });

    expect(result.decision).toBe("blocked");
    expect(result.reasons).toContain("local_scan_failed");
  });
});
