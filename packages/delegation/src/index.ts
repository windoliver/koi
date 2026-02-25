/**
 * @koi/delegation — Monotonic attenuation delegation tokens (Layer 2)
 *
 * Provides agent-to-agent permission delegation with:
 * - HMAC-SHA256 signed grants
 * - Monotonic scope attenuation (child <= parent)
 * - Chain tracking with depth limits
 * - Cascading revocation
 * - Pluggable revocation registry
 * - KoiMiddleware integration
 * - DelegationManager coordinator with circuit breaker
 */

// circuit breaker
export type { CircuitBreaker, CircuitState } from "./circuit-breaker.js";
export { createCircuitBreaker } from "./circuit-breaker.js";
// delegation manager
export type { CreateDelegationManagerParams, DelegationManager } from "./delegation-manager.js";
export { createDelegationManager } from "./delegation-manager.js";
export type { AttenuateParams, CreateGrantParams } from "./grant.js";
// grant creation & attenuation
export { attenuateGrant, createGrant } from "./grant.js";
// middleware
export { createDelegationMiddleware } from "./middleware.js";
export type { GrantIndex, InMemoryRegistry } from "./registry.js";
// registry
export { createGrantIndex, createInMemoryRegistry } from "./registry.js";
// revocation
export { revokeGrant } from "./revoke.js";
// signing
export { signGrant, verifySignature } from "./sign.js";
// test helpers
export {
  createAsyncRevocationRegistry,
  createRegistryCleanup,
  mustCreateGrant,
} from "./test-helpers.js";
// verification
export { defaultScopeChecker, matchToolAgainstScope, verifyGrant } from "./verify.js";
// verify cache
export type { VerifyCache } from "./verify-cache.js";
export { createVerifyCache } from "./verify-cache.js";
