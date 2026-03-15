/**
 * @koi/delegation-nexus — Nexus-backed delegation for agent spawn.
 *
 * Implements DelegationComponent (L0) backed by Nexus REST API for
 * durable, cross-node agent delegation with Zanzibar-style ReBAC.
 */

// backend
export type { NexusDelegationBackendConfig } from "./nexus-delegation-backend.js";
export { createNexusDelegationBackend } from "./nexus-delegation-backend.js";
// provider
export type { NexusDelegationProviderConfig } from "./nexus-delegation-provider.js";
export { createNexusDelegationProvider } from "./nexus-delegation-provider.js";
// scope mapping
export { mapNamespaceMode, mapScopeToNexus } from "./scope-mapping.js";
// TTL verify cache
export type { TtlVerifyCache, TtlVerifyCacheConfig } from "./ttl-verify-cache.js";
export { createTtlVerifyCache } from "./ttl-verify-cache.js";
