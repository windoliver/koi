/**
 * @koi/federation — Multi-zone agent coordination & edge sync (Phase 3 baseline).
 *
 * L2 feature package. Depends on @koi/core (L0) and @koi/nexus-client (L0u).
 *
 * Vector clocks, LWW conflict resolution, adaptive polling, snapshot
 * truncation, and clock pruning are deferred to #1410 (Phase 4e).
 */

// config
export { validateFederationConfig } from "./config.js";
// federation middleware
export type {
  FederationAbortError,
  FederationMiddlewareConfig,
  FederationPrincipalPolicy,
  FederationRemoteCapabilities,
  TenantResolverContext,
} from "./federation-middleware.js";
export { createFederationMiddleware } from "./federation-middleware.js";
// sync engine
export type { RemoteHealth, SyncEngineConfig, SyncEngineHandle } from "./sync-engine.js";
export { createSyncEngine } from "./sync-engine.js";
// sync protocol
export type { NexusSyncClientConfig, SyncClient } from "./sync-protocol.js";
export { advanceCursor, createNexusSyncClient, deduplicateEvents } from "./sync-protocol.js";
// types
export type { FederationConfig, FederationSyncEvent, SyncCursor } from "./types.js";
export { DEFAULT_FEDERATION_CONFIG, FEDERATION_PROTOCOL_VERSION } from "./types.js";
// zone registry (Nexus-backed)
export type { ZoneRegistryNexusConfig } from "./zone-registry-nexus.js";
export { createZoneRegistryNexus } from "./zone-registry-nexus.js";
