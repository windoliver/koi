/**
 * @koi/federation — Multi-zone agent coordination & edge sync.
 *
 * L2 feature package. Depends on @koi/core (L0) and @koi/nexus-client (L0u).
 *
 * Includes sequence-cursor sync, vector-clock metadata, conflict reporting,
 * and cross-zone tool routing.
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
export type {
  ClockOrder,
  ConflictReport,
  ConflictResolutionResult,
  ConflictResolutionStrategy,
  FederationConfig,
  FederationSyncEvent,
  ReportedConflict,
  SyncCursor,
  VectorClock,
} from "./types.js";
export { DEFAULT_FEDERATION_CONFIG, FEDERATION_PROTOCOL_VERSION } from "./types.js";
// vector clock + conflict helpers
export {
  compareVectorClock,
  detectEventConflict,
  getConflictResourceKey,
  incrementVectorClock,
  mergeVectorClock,
  pruneVectorClock,
  resolveEventConflict,
} from "./vector-clock.js";
// zone registry (Nexus-backed)
export type { ServerReadsMode, ZoneRegistryNexusConfig } from "./zone-registry-nexus.js";
export { createZoneRegistryNexus } from "./zone-registry-nexus.js";
