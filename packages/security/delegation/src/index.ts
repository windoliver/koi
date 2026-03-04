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

// capability request bridge
export {
  type CapabilityRequestBridge,
  type CapabilityRequestBridgeConfig,
  createCapabilityRequestBridge,
} from "./capability-request-bridge.js";
// capability request constants
export {
  CAPABILITY_REQUEST_TYPE,
  CAPABILITY_RESPONSE_STATUS,
  type CapabilityResponseStatus,
} from "./capability-request-constants.js";
// circuit breaker
export type { CircuitBreaker, CircuitState } from "./circuit-breaker.js";
export { createCircuitBreaker } from "./circuit-breaker.js";
// delegation manager
export type { CreateDelegationManagerParams, DelegationManager } from "./delegation-manager.js";
export { createDelegationManager } from "./delegation-manager.js";
// delegation provider (ComponentProvider)
export { createDelegationProvider, type DelegationProviderConfig } from "./delegation-provider.js";
export type { AttenuateParams, CreateGrantParams } from "./grant.js";
// grant creation & attenuation
export { attenuateGrant, createGrant } from "./grant.js";
// grant→token mapping
export { mapGrantToCapabilityToken } from "./map-grant-to-token.js";
export type { DelegationMiddlewareConfig } from "./middleware.js";
// middleware
export { createDelegationMiddleware } from "./middleware.js";
export type { GrantIndex, InMemoryRegistry } from "./registry.js";
// registry
export { createGrantIndex, createInMemoryRegistry } from "./registry.js";
// resource pattern parsing
export { parseResourcePattern, type ResourcePattern } from "./resource-pattern.js";
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
// tool: check
export { createDelegationCheckTool } from "./tools/check.js";
// tool constants
export { DEFAULT_PREFIX, type DelegationOperation, OPERATIONS } from "./tools/constants.js";
// verification
export { defaultScopeChecker, matchToolAgainstScope, verifyGrant } from "./verify.js";
// verify cache
export type { VerifyCache } from "./verify-cache.js";
export { createVerifyCache } from "./verify-cache.js";
// wait utility
export {
  type WaitForResponseConfig,
  type WaitResult,
  waitForResponse,
} from "./wait-for-response.js";
