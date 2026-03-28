import { describe, expect, it } from "bun:test";
import type { BrickSignature } from "@koi/core";

import type { BrickIdentityPayload } from "./brick-signing.js";
import {
  classifyTrustTier,
  computeSigningPayload,
  generateBrickSigningKeyPair,
  signBrick,
  verifyBrickSignature,
} from "./brick-signing.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_BRICK: BrickIdentityPayload = {
  contentHash: "sha256:abc123def456",
  kind: "tool",
  name: "test-brick",
};

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

describe("generateBrickSigningKeyPair", () => {
  it("returns base64-encoded public and private keys", () => {
    const pair = generateBrickSigningKeyPair();
    expect(typeof pair.publicKeyDer).toBe("string");
    expect(typeof pair.privateKeyDer).toBe("string");
    expect(pair.publicKeyDer.length).toBeGreaterThan(0);
    expect(pair.privateKeyDer.length).toBeGreaterThan(0);
  });

  it("generates unique key pairs on each call", () => {
    const a = generateBrickSigningKeyPair();
    const b = generateBrickSigningKeyPair();
    expect(a.publicKeyDer).not.toBe(b.publicKeyDer);
    expect(a.privateKeyDer).not.toBe(b.privateKeyDer);
  });
});

// ---------------------------------------------------------------------------
// Signing payload
// ---------------------------------------------------------------------------

describe("computeSigningPayload", () => {
  it("produces deterministic canonical JSON", () => {
    const payload1 = computeSigningPayload(SAMPLE_BRICK);
    const payload2 = computeSigningPayload(SAMPLE_BRICK);
    expect(payload1).toBe(payload2);
  });

  it("sorts keys lexicographically", () => {
    const payload = computeSigningPayload(SAMPLE_BRICK);
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    expect(keys).toEqual(["contentHash", "kind", "name"]);
  });

  it("includes all three identity fields", () => {
    const payload = computeSigningPayload(SAMPLE_BRICK);
    expect(payload).toContain("sha256:abc123def456");
    expect(payload).toContain("tool");
    expect(payload).toContain("test-brick");
  });
});

// ---------------------------------------------------------------------------
// Sign + verify round-trip
// ---------------------------------------------------------------------------

describe("signBrick + verifyBrickSignature", () => {
  it("round-trip succeeds with matching key pair", () => {
    const { publicKeyDer, privateKeyDer } = generateBrickSigningKeyPair();

    const signResult = signBrick(SAMPLE_BRICK, privateKeyDer, publicKeyDer);
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const sig = signResult.value;
    expect(sig.algorithm).toBe("ed25519");
    expect(sig.publicKey).toBe(publicKeyDer);
    expect(sig.signedAt).toBeGreaterThan(0);

    const verifyResult = verifyBrickSignature(SAMPLE_BRICK, sig);
    expect(verifyResult.ok).toBe(true);
    if (verifyResult.ok) {
      expect(verifyResult.trustTier).toBe("community");
    }
  });

  it("verification fails with wrong key", () => {
    const pair1 = generateBrickSigningKeyPair();
    const pair2 = generateBrickSigningKeyPair();

    const signResult = signBrick(SAMPLE_BRICK, pair1.privateKeyDer, pair1.publicKeyDer);
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    // Tamper: replace public key with pair2's key
    const tampered: BrickSignature = {
      ...signResult.value,
      publicKey: pair2.publicKeyDer,
    };

    const verifyResult = verifyBrickSignature(SAMPLE_BRICK, tampered);
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.reason).toBe("Signature verification failed");
    }
  });

  it("verification fails with tampered content", () => {
    const { publicKeyDer, privateKeyDer } = generateBrickSigningKeyPair();

    const signResult = signBrick(SAMPLE_BRICK, privateKeyDer, publicKeyDer);
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    // Verify against different brick content
    const tamperedBrick: BrickIdentityPayload = {
      contentHash: "sha256:tampered",
      kind: "tool",
      name: "test-brick",
    };

    const verifyResult = verifyBrickSignature(tamperedBrick, signResult.value);
    expect(verifyResult.ok).toBe(false);
  });

  it("verification fails with tampered name", () => {
    const { publicKeyDer, privateKeyDer } = generateBrickSigningKeyPair();

    const signResult = signBrick(SAMPLE_BRICK, privateKeyDer, publicKeyDer);
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const tamperedBrick: BrickIdentityPayload = {
      contentHash: SAMPLE_BRICK.contentHash,
      kind: SAMPLE_BRICK.kind,
      name: "evil-brick",
    };

    const verifyResult = verifyBrickSignature(tamperedBrick, signResult.value);
    expect(verifyResult.ok).toBe(false);
  });

  it("verification fails with tampered kind", () => {
    const { publicKeyDer, privateKeyDer } = generateBrickSigningKeyPair();

    const signResult = signBrick(SAMPLE_BRICK, privateKeyDer, publicKeyDer);
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const tamperedBrick: BrickIdentityPayload = {
      contentHash: SAMPLE_BRICK.contentHash,
      kind: "skill",
      name: SAMPLE_BRICK.name,
    };

    const verifyResult = verifyBrickSignature(tamperedBrick, signResult.value);
    expect(verifyResult.ok).toBe(false);
  });

  it("rejects unsupported algorithm", () => {
    const { publicKeyDer, privateKeyDer } = generateBrickSigningKeyPair();

    const signResult = signBrick(SAMPLE_BRICK, privateKeyDer, publicKeyDer);
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const wrongAlgo: BrickSignature = {
      ...signResult.value,
      algorithm: "rsa-sha256",
    };

    const verifyResult = verifyBrickSignature(SAMPLE_BRICK, wrongAlgo);
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.reason).toContain("Unsupported algorithm");
    }
  });

  it("handles corrupted signature gracefully", () => {
    const { publicKeyDer } = generateBrickSigningKeyPair();

    const corruptSig: BrickSignature = {
      algorithm: "ed25519",
      signature: "not-valid-base64!!!",
      publicKey: publicKeyDer,
      signedAt: Date.now(),
    };

    const verifyResult = verifyBrickSignature(SAMPLE_BRICK, corruptSig);
    expect(verifyResult.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// signBrick error handling
// ---------------------------------------------------------------------------

describe("signBrick error handling", () => {
  it("returns error for invalid private key", () => {
    const { publicKeyDer } = generateBrickSigningKeyPair();
    const result = signBrick(SAMPLE_BRICK, "not-a-valid-key", publicKeyDer);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SIGNING_FAILED");
    }
  });
});

// ---------------------------------------------------------------------------
// Trust tier classification
// ---------------------------------------------------------------------------

describe("classifyTrustTier", () => {
  it("returns 'local' when signature is undefined", () => {
    const tier = classifyTrustTier(undefined, SAMPLE_BRICK, new Set());
    expect(tier).toBe("local");
  });

  it("returns 'community' for valid signature with untrusted key", () => {
    const { publicKeyDer, privateKeyDer } = generateBrickSigningKeyPair();

    const signResult = signBrick(SAMPLE_BRICK, privateKeyDer, publicKeyDer);
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const tier = classifyTrustTier(signResult.value, SAMPLE_BRICK, new Set());
    expect(tier).toBe("community");
  });

  it("returns 'verified' for valid signature with trusted key", () => {
    const { publicKeyDer, privateKeyDer } = generateBrickSigningKeyPair();

    const signResult = signBrick(SAMPLE_BRICK, privateKeyDer, publicKeyDer);
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const trustedKeys = new Set([publicKeyDer]);
    const tier = classifyTrustTier(signResult.value, SAMPLE_BRICK, trustedKeys);
    expect(tier).toBe("verified");
  });

  it("returns 'local' for invalid signature", () => {
    const corruptSig: BrickSignature = {
      algorithm: "ed25519",
      signature: "corrupt",
      publicKey: "corrupt",
      signedAt: Date.now(),
    };

    const tier = classifyTrustTier(corruptSig, SAMPLE_BRICK, new Set());
    expect(tier).toBe("local");
  });

  it("returns 'community' even when key is in trusted set but signature is for different brick", () => {
    const { publicKeyDer, privateKeyDer } = generateBrickSigningKeyPair();

    const signResult = signBrick(SAMPLE_BRICK, privateKeyDer, publicKeyDer);
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const differentBrick: BrickIdentityPayload = {
      contentHash: "sha256:different",
      kind: "tool",
      name: "other-brick",
    };

    // Signature was for SAMPLE_BRICK, not differentBrick — verification will fail
    const trustedKeys = new Set([publicKeyDer]);
    const tier = classifyTrustTier(signResult.value, differentBrick, trustedKeys);
    expect(tier).toBe("local"); // Falls back to local because signature doesn't match
  });
});
