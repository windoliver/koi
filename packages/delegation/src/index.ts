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
 */

export type { AttenuateParams, CreateGrantParams } from "./grant.js";

// grant creation & attenuation
export { attenuateGrant, createGrant } from "./grant.js";
// middleware
export { createDelegationMiddleware } from "./middleware.js";
export type { GrantIndex } from "./registry.js";
// registry
export { createGrantIndex, createInMemoryRegistry } from "./registry.js";
// revocation
export { revokeGrant } from "./revoke.js";
// signing
export { signGrant, verifySignature } from "./sign.js";
// verification
export { defaultScopeChecker, matchToolAgainstScope, verifyGrant } from "./verify.js";
