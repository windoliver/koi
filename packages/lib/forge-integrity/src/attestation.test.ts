import { describe, expect, test } from "bun:test";
import type { ForgeProvenance, SigningBackend } from "@koi/core";
import { createHmacSigner } from "@koi/hash";
import { makeTool } from "./__tests__/fixtures.js";
import { signAttestation, verifyAttestation } from "./attestation.js";

const signer: SigningBackend = createHmacSigner(new TextEncoder().encode("secret"));

function provenance(): ForgeProvenance {
  return makeTool().provenance;
}

describe("attestation signing", () => {
  test("signed provenance verifies with the same signer", async () => {
    const signed = await signAttestation(provenance(), signer, { keyId: "local-key" });
    const result = await verifyAttestation(signed, signer);

    expect(signed.attestation?.algorithm).toBe("hmac-sha256");
    expect(signed.attestation?.keyId).toBe("local-key");
    expect(result.kind).toBe("ok");
    expect(result.ok).toBe(true);
  });

  test("tampered provenance is rejected", async () => {
    const signed = await signAttestation(provenance(), signer);
    const tampered: ForgeProvenance = {
      ...signed,
      contentHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    };
    const result = await verifyAttestation(tampered, signer);

    expect(result.kind).toBe("signature_invalid");
    expect(result.ok).toBe(false);
  });

  test("missing attestation is rejected", async () => {
    const result = await verifyAttestation(provenance(), signer);

    expect(result.kind).toBe("missing_attestation");
    expect(result.ok).toBe(false);
  });

  test("malformed base64 signature is rejected before verifier execution", async () => {
    const signed = await signAttestation(provenance(), signer);
    const malformed: ForgeProvenance = {
      ...signed,
      attestation: {
        algorithm: "hmac-sha256",
        signature: "not base64!",
      },
    };
    const result = await verifyAttestation(malformed, signer);

    expect(result.kind).toBe("malformed");
    expect(result.ok).toBe(false);
  });

  test("expired provenance is rejected before signature trust is granted", async () => {
    const signed = await signAttestation(provenance(), signer);
    const result = await verifyAttestation(signed, signer, {
      now: 10_000,
      maxAgeMs: 1,
    });

    expect(result.kind).toBe("expired");
    expect(result.ok).toBe(false);
  });
});
