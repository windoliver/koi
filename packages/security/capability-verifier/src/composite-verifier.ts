/**
 * Composite CapabilityVerifier — routes to per-proof-type verifiers.
 *
 * Delegates verification to the appropriate verifier based on token.proof.kind:
 * - "hmac-sha256" → HmacVerifier
 * - "ed25519" → Ed25519Verifier
 * - "nexus" → proof_type_unsupported (v2 deferred)
 *
 * Optionally wraps verification with a VerifierCache to avoid repeated
 * computation for the same (tokenId, toolId) pair.
 */

import type {
  CapabilityId,
  CapabilityToken,
  CapabilityVerifier,
  CapabilityVerifyResult,
  ScopeChecker,
  VerifierCache,
  VerifyContext,
} from "@koi/core";
import type { PublicKeyRegistry } from "./ed25519-verifier.js";
import { createEd25519Verifier } from "./ed25519-verifier.js";
import { createHmacVerifier } from "./hmac-verifier.js";

export interface CompositeVerifierConfig {
  /** HMAC-SHA256 secret for root→engine tokens. */
  readonly hmacSecret: string;
  /** Optional cache for verification results. */
  readonly cache?: VerifierCache | undefined;
  /** Optional pluggable scope checker — when provided, verifiers delegate scope checking to it. */
  readonly scopeChecker?: ScopeChecker | undefined;
  /** Optional public key registry for Ed25519 issuer-key binding verification. */
  readonly keyRegistry?: PublicKeyRegistry | undefined;
}

/**
 * Creates a composite CapabilityVerifier that routes to the correct
 * per-proof-type verifier based on token.proof.kind.
 *
 * Caching: if a cache is provided, results are stored after first verification
 * and returned on subsequent calls for the same (tokenId, toolId) pair.
 * On revocation, the caller is responsible for calling cache.evict(tokenId).
 */
export function createCompositeVerifier(config: CompositeVerifierConfig): CapabilityVerifier {
  const hmacVerifier = createHmacVerifier(config.hmacSecret, config.scopeChecker);
  const ed25519Verifier = createEd25519Verifier(config.scopeChecker, config.keyRegistry);

  function verify(token: CapabilityToken, context: VerifyContext): CapabilityVerifyResult {
    // Check cache first — but re-check expiry and session revocation before returning
    if (config.cache !== undefined) {
      const cached = config.cache.get(token.id, context.toolId);
      if (cached !== undefined) {
        if (token.expiresAt <= (context.now ?? Date.now())) {
          config.cache.evict(token.id);
          return { ok: false, reason: "expired" };
        }
        // Re-check session revocation even on cache hit — session may have
        // been revoked since the result was cached
        if (!context.activeSessionIds.has(token.scope.sessionId)) {
          config.cache.evict(token.id);
          return { ok: false, reason: "session_invalid" };
        }
        return cached;
      }
    }

    const result = computeVerification(token, context);

    // Store in cache (cache both allow and deny results)
    if (config.cache !== undefined) {
      config.cache.set(token.id, context.toolId, result);
    }

    return result;
  }

  function computeVerification(
    token: CapabilityToken,
    context: VerifyContext,
  ): CapabilityVerifyResult {
    switch (token.proof.kind) {
      case "hmac-sha256":
        return hmacVerifier.verify(token, context) as CapabilityVerifyResult;
      case "ed25519":
        return ed25519Verifier.verify(token, context) as CapabilityVerifyResult;
      case "nexus":
        // nexus backend deferred to v2 — interface defined, no implementation yet
        return { ok: false, reason: "proof_type_unsupported" };
    }
  }

  return {
    verify,
    ...(config.cache !== undefined ? { cache: config.cache } : {}),
  };
}

/**
 * Creates a simple in-memory VerifierCache.
 *
 * Key format: `${tokenId}:${toolId}`. No TTL — entries live until evicted.
 * Eviction removes all entries for a given tokenId (called on revocation).
 *
 * This is a simple implementation suitable for single-session use.
 * For high-throughput scenarios, consider an LRU cache with TTL.
 */
export function createInMemoryVerifierCache(): VerifierCache {
  const store = new Map<string, CapabilityVerifyResult>();

  function makeKey(tokenId: CapabilityId, toolId: string): string {
    return `${tokenId}\0${toolId}`;
  }

  return {
    get(tokenId: CapabilityId, toolId: string): CapabilityVerifyResult | undefined {
      return store.get(makeKey(tokenId, toolId));
    },
    set(tokenId: CapabilityId, toolId: string, result: CapabilityVerifyResult): void {
      store.set(makeKey(tokenId, toolId), result);
    },
    evict(tokenId: CapabilityId): void {
      const prefix = `${tokenId}\0`;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          store.delete(key);
        }
      }
    },
  };
}
