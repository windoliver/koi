/**
 * Tests for forge verification logic — integrity + trust tier classification.
 */

import { describe, expect, test } from "bun:test";
import type { BrickArtifact } from "@koi/core";
import { generateBrickSigningKeyPair, signBrick } from "@koi/forge-integrity";
import { computeBrickId } from "@koi/hash";
import { createTestToolArtifact } from "@koi/test-utils";
import { verifyAndClassifyBrick } from "./forge-verify.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validToolBrick(
  overrides?: Partial<Parameters<typeof createTestToolArtifact>[0]>,
): ReturnType<typeof createTestToolArtifact> {
  const impl = overrides?.implementation ?? "return 1;";
  const id = overrides?.id ?? computeBrickId("tool", impl);
  return createTestToolArtifact({ ...overrides, id, implementation: impl });
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

describe("verifyAndClassifyBrick — integrity", () => {
  test("integrity passes for valid brick", () => {
    const brick = validToolBrick({ implementation: "return 42;" });
    const result = verifyAndClassifyBrick(brick, new Set());
    expect(result.integrityOk).toBe(true);
    expect(result.integrityKind).toBe("ok");
  });

  test("integrity fails for tampered brick", () => {
    const originalImpl = "return 42;";
    const id = computeBrickId("tool", originalImpl);
    const brick: BrickArtifact = createTestToolArtifact({
      id,
      implementation: "return hacked();",
    });
    const result = verifyAndClassifyBrick(brick, new Set());
    expect(result.integrityOk).toBe(false);
    expect(result.integrityKind).toBe("content_mismatch");
  });
});

// ---------------------------------------------------------------------------
// Trust tier classification
// ---------------------------------------------------------------------------

describe("verifyAndClassifyBrick — trust tier", () => {
  test("unsigned brick -> local", () => {
    const brick = validToolBrick();
    const result = verifyAndClassifyBrick(brick, new Set());
    expect(result.trustTier).toBe("local");
  });

  test("signed brick with untrusted key -> community", () => {
    const { publicKeyDer, privateKeyDer } = generateBrickSigningKeyPair();
    const brick = validToolBrick({ implementation: "return signed();" });

    const signResult = signBrick(
      { contentHash: brick.provenance.contentHash, kind: brick.kind, name: brick.name },
      privateKeyDer,
      publicKeyDer,
    );
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const signedBrick: BrickArtifact = { ...brick, signature: signResult.value } as BrickArtifact;
    const result = verifyAndClassifyBrick(signedBrick, new Set());
    expect(result.trustTier).toBe("community");
  });

  test("signed brick with trusted key -> verified", () => {
    const { publicKeyDer, privateKeyDer } = generateBrickSigningKeyPair();
    const brick = validToolBrick({ implementation: "return verified();" });

    const signResult = signBrick(
      { contentHash: brick.provenance.contentHash, kind: brick.kind, name: brick.name },
      privateKeyDer,
      publicKeyDer,
    );
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const signedBrick: BrickArtifact = { ...brick, signature: signResult.value } as BrickArtifact;
    const trustedKeys = new Set([publicKeyDer]);
    const result = verifyAndClassifyBrick(signedBrick, trustedKeys);
    expect(result.trustTier).toBe("verified");
  });

  test("corrupt signature -> local", () => {
    const brick = validToolBrick({ implementation: "return corrupt();" });
    const corruptBrick: BrickArtifact = {
      ...brick,
      signature: {
        algorithm: "ed25519",
        signature: "corrupt",
        publicKey: "corrupt",
        signedAt: Date.now(),
      },
    } as BrickArtifact;
    const result = verifyAndClassifyBrick(corruptBrick, new Set());
    expect(result.trustTier).toBe("local");
  });
});
