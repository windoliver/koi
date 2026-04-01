/**
 * Extracted forge brick verification logic — testable without CLI concerns.
 *
 * Composes verifyBrickIntegrity + classifyTrustTier into a single
 * VerificationResult for use by the install command.
 */

import type { BrickArtifact, BrickSignature, TrustTier } from "@koi/core";
import { classifyTrustTier, verifyBrickIntegrity } from "@koi/forge-integrity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationResult {
  readonly integrityOk: boolean;
  readonly integrityKind: string;
  readonly trustTier: TrustTier;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a brick's content integrity and classify its trust tier.
 *
 * @param brick - The brick artifact to verify.
 * @param trustedKeys - Set of registry-trusted public keys (empty = no "verified" tier).
 * @returns Combined integrity and trust classification result.
 */
export function verifyAndClassifyBrick(
  brick: BrickArtifact,
  trustedKeys: ReadonlySet<string>,
): VerificationResult {
  const integrity = verifyBrickIntegrity(brick);

  const trustTier = classifyTrustTier(
    (brick as { readonly signature?: BrickSignature }).signature,
    { contentHash: brick.provenance.contentHash, kind: brick.kind, name: brick.name },
    trustedKeys,
  );

  return {
    integrityOk: integrity.ok,
    integrityKind: integrity.kind,
    trustTier,
  };
}
