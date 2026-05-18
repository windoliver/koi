import { describe, expect, test } from "bun:test";
import type { SigningBackend } from "@koi/core";
import { createHmacSigner } from "@koi/hash";
import { makeTool, recomputeFixtureId, tamper } from "./__tests__/fixtures.js";
import { signAttestation } from "./attestation.js";
import { verifyInstallProvenance } from "./install-verification.js";
import { createBrickVerifier } from "./integrity.js";

const TRUSTED_BUILDER = "koi/forge";
const signer: SigningBackend = createHmacSigner(new TextEncoder().encode("secret"));
const verifier = createBrickVerifier({ [TRUSTED_BUILDER]: recomputeFixtureId });

describe("install provenance verification", () => {
  test("accepts a brick with valid integrity and attestation", async () => {
    const brick = makeTool();
    const signed = { ...brick, provenance: await signAttestation(brick.provenance, signer) };
    const result = await verifyInstallProvenance(signed, {
      expectedBuilderId: TRUSTED_BUILDER,
      verifier,
      signer,
    });

    expect(result.kind).toBe("ok");
    expect(result.ok).toBe(true);
  });

  test("rejects a tampered brick before install", async () => {
    const brick = makeTool();
    const signed = { ...brick, provenance: await signAttestation(brick.provenance, signer) };
    const result = await verifyInstallProvenance(tamper(signed), {
      expectedBuilderId: TRUSTED_BUILDER,
      verifier,
      signer,
    });

    expect(result.kind).toBe("integrity_failed");
    expect(result.ok).toBe(false);
  });

  test("rejects a brick with missing attestation", async () => {
    const result = await verifyInstallProvenance(makeTool(), {
      expectedBuilderId: TRUSTED_BUILDER,
      verifier,
      signer,
    });

    expect(result.kind).toBe("attestation_failed");
    expect(result.ok).toBe(false);
  });
});
