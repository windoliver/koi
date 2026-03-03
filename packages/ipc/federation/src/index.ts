/**
 * @koi/federation — Multi-zone agent coordination & edge sync.
 *
 * L2 feature package. Depends on @koi/core (L0) and @koi/nexus-client (L0u).
 */

// config
export { validateFederationConfig } from "./config.js";
// federation middleware
export type { FederationMiddlewareConfig } from "./federation-middleware.js";
export { createFederationMiddleware } from "./federation-middleware.js";
// sync engine
export type { SyncEngineConfig, SyncEngineHandle } from "./sync-engine.js";
export { createSyncEngine } from "./sync-engine.js";
// sync protocol
export type { NexusSyncClientConfig, SyncClient } from "./sync-protocol.js";
export {
  advanceCursor,
  createNexusSyncClient,
  deduplicateEvents,
  resolveConflict,
} from "./sync-protocol.js";
// types
export type {
  ClockOrder,
  ConflictResolution,
  FederationConfig,
  FederationSyncEvent,
  SyncCursor,
  VectorClock,
} from "./types.js";
export { DEFAULT_FEDERATION_CONFIG } from "./types.js";
// vector clock
export {
  compareClock,
  incrementClock,
  isAfterCursor,
  mergeClock,
  pruneClock,
} from "./vector-clock.js";
// zone registry (Nexus-backed)
export type { ZoneRegistryNexusConfig } from "./zone-registry-nexus.js";
export { createZoneRegistryNexus } from "./zone-registry-nexus.js";
