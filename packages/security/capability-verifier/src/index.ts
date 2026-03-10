/**
 * @koi/capability-verifier — L2 capability token verification.
 *
 * Provides HMAC-SHA256 and Ed25519 capability token verification,
 * session-scoped revocation, and delegation chain traversal.
 *
 * Entry points:
 * - createCapabilityVerifier() — composite verifier factory
 * - createSessionRevocationStore() — session lifecycle management
 * - verifyChain() — delegation chain integrity check
 * - isAttenuated() — scope attenuation predicate
 */

export { isAttenuated } from "./attenuation.js";
export type { ChainVerifyResult } from "./chain-verifier.js";
export {
  buildChainMap,
  getOrCreateEd25519Keypair,
  reconstructChain,
  verifyChain,
} from "./chain-verifier.js";
export type { CompositeVerifierConfig } from "./composite-verifier.js";
// Re-export the primary factory as createCapabilityVerifier for ergonomics
export {
  createCompositeVerifier,
  createCompositeVerifier as createCapabilityVerifier,
  createInMemoryVerifierCache,
} from "./composite-verifier.js";
export type { PublicKeyRegistry } from "./ed25519-verifier.js";
export { createEd25519Verifier } from "./ed25519-verifier.js";
export { createHmacVerifier } from "./hmac-verifier.js";
export type { SessionRevocationStore } from "./session-revocation.js";
export { createSessionRevocationStore } from "./session-revocation.js";
