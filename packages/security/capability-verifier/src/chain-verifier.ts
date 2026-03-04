/**
 * Chain verifier — traverses and validates a delegation chain.
 *
 * Validates that every token in a chain from root to leaf is valid:
 * - Each token's chainDepth matches its position in the chain
 * - Each child's scope is a strict attenuation of its parent's scope
 * - Each child's expiresAt <= parent's expiresAt
 * - None of the tokens in the chain are revoked
 *
 * Uses RevocationRegistry.isRevokedBatch (Issue 13) when available to
 * avoid N+1 async lookups when traversing deep chains.
 *
 * Lazy Ed25519 keypair generation (Issue 15): keypairs are generated on the
 * first call to grant() using generateKeyPairSync.
 */

import { generateKeyPairSync } from "node:crypto";
import type {
  CapabilityId,
  CapabilityToken,
  DelegationId,
  RevocationRegistry,
  VerifyContext,
} from "@koi/core";
import { isAttenuated } from "./attenuation.js";

/**
 * The chain verifier checks a full delegation chain for integrity.
 * It does NOT verify individual proof signatures — that is delegated
 * to the per-proof-type verifiers (HMAC, Ed25519).
 */

/**
 * Lazily generated Ed25519 keypair for signing new capability tokens.
 * Generated on first grant() call, never before (Issue 15).
 */
let cachedKeypair: { readonly privateKey: Buffer; readonly publicKey: Buffer } | undefined;

/**
 * Returns the lazy-initialized Ed25519 keypair.
 * Generated on first call using Node.js crypto.
 */
export function getOrCreateEd25519Keypair(): {
  readonly privateKey: Buffer;
  readonly publicKey: Buffer;
} {
  if (cachedKeypair !== undefined) return cachedKeypair;

  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });

  cachedKeypair = {
    privateKey: Buffer.from(privateKey),
    publicKey: Buffer.from(publicKey),
  };
  return cachedKeypair;
}

/**
 * Resets the cached keypair (for testing purposes only).
 * In production, the keypair is generated once and reused.
 */
export function resetKeypairCache(): void {
  cachedKeypair = undefined;
}

/**
 * Result of chain verification.
 */
export type ChainVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "revoked" | "chain_depth_exceeded" | "scope_exceeded" };

/**
 * Verifies the entire delegation chain anchored at the given leaf token.
 *
 * @param chain - The chain from root [0] to leaf [N-1]. Must be ordered.
 * @param registry - Revocation registry. Uses isRevokedBatch if available.
 * @param context - Current verify context (sessionId, now, etc.).
 * @returns ok: true if the chain is valid; ok: false with reason otherwise.
 */
export async function verifyChain(
  chain: readonly CapabilityToken[],
  registry: RevocationRegistry,
  _context: VerifyContext,
): Promise<ChainVerifyResult> {
  if (chain.length === 0) return { ok: true };

  // Batch revocation check (avoids N+1 async lookups)
  // DelegationId and CapabilityId are both branded strings — cast is safe
  // since we're using the same underlying string value.
  const ids = chain.map((t) => t.id as unknown as DelegationId);
  const revokedMap = await batchRevocationCheck(ids, registry);

  for (let i = 0; i < chain.length; i++) {
    const token = chain[i];
    if (token === undefined) continue;

    // Check revocation
    const tokenId = token.id as unknown as DelegationId;
    if (revokedMap.get(tokenId) === true) {
      return { ok: false, reason: "revoked" };
    }

    // Check chain depth consistency
    if (token.chainDepth !== i) {
      return { ok: false, reason: "chain_depth_exceeded" };
    }

    // Check child is a valid attenuation of parent
    if (i > 0) {
      const parent = chain[i - 1];
      if (parent === undefined) continue;

      if (!isAttenuated(token.scope.permissions, parent.scope.permissions)) {
        return { ok: false, reason: "scope_exceeded" };
      }

      if (token.expiresAt > parent.expiresAt) {
        return { ok: false, reason: "scope_exceeded" };
      }
    }
  }

  return { ok: true };
}

/**
 * Performs a batch revocation check, using isRevokedBatch when available
 * and falling back to sequential isRevoked calls otherwise.
 */
async function batchRevocationCheck(
  ids: readonly DelegationId[],
  registry: RevocationRegistry,
): Promise<ReadonlyMap<DelegationId, boolean>> {
  // Try batch first, fall back to sequential, fail-closed on error
  if (registry.isRevokedBatch !== undefined) {
    try {
      return await registry.isRevokedBatch(ids);
    } catch {
      // Batch failed — fall through to sequential
    }
  }

  // Sequential fallback — fail-closed on any error
  const results = new Map<DelegationId, boolean>();
  for (const id of ids) {
    try {
      results.set(id, await registry.isRevoked(id));
    } catch {
      // Fail-closed: treat lookup error as revoked
      results.set(id, true);
    }
  }
  return results;
}

/**
 * Builds a chain lookup map from a flat array of tokens.
 * Useful for constructing chains from a token store.
 */
export function buildChainMap(
  tokens: readonly CapabilityToken[],
): ReadonlyMap<CapabilityId, CapabilityToken> {
  const map = new Map<CapabilityId, CapabilityToken>();
  for (const token of tokens) {
    map.set(token.id, token);
  }
  return map;
}

/**
 * Reconstructs the full chain from a leaf token up to the root.
 * Returns the chain in root-first order [root, ..., leaf].
 *
 * Returns undefined if the chain is broken (parentId points to unknown token).
 */
export function reconstructChain(
  leaf: CapabilityToken,
  tokenStore: ReadonlyMap<CapabilityId, CapabilityToken>,
): readonly CapabilityToken[] | undefined {
  const chain: CapabilityToken[] = [leaf];
  let current: CapabilityToken = leaf;

  while (current.parentId !== undefined) {
    const parent = tokenStore.get(current.parentId);
    if (parent === undefined) {
      // Chain gap — parentId points to unknown token
      return undefined;
    }
    chain.unshift(parent);
    current = parent;
  }

  return chain;
}
