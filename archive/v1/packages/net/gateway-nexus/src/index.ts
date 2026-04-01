/**
 * @koi/gateway-nexus — Nexus-backed gateway state stores (Layer 2)
 *
 * Provides SessionStore, NodeRegistry, and SurfaceStore implementations
 * backed by Nexus for multi-instance HA deployment.
 * Depends on @koi/core, @koi/gateway-types, and @koi/nexus-client only.
 */

// config
export type {
  DegradationConfig,
  GatewayNexusConfig,
  PollingConfig,
  WriteQueueConfig,
} from "./config.js";
export {
  DEFAULT_DEGRADATION_CONFIG,
  DEFAULT_POLLING_CONFIG,
  DEFAULT_WRITE_QUEUE_CONFIG,
  validateGatewayNexusConfig,
} from "./config.js";

// degradation
export type { DegradationMode, DegradationState } from "./degradation.js";
export {
  createDegradationState,
  recordFailure,
  recordSuccess,
  shouldProbe,
} from "./degradation.js";
// nexus node registry
export type { NexusNodeRegistryHandle, NexusNodeRegistryOptions } from "./nexus-node-registry.js";
export { createNexusNodeRegistry } from "./nexus-node-registry.js";

// nexus session store
export type { NexusSessionStoreHandle, NexusSessionStoreOptions } from "./nexus-session-store.js";
export { createNexusSessionStore } from "./nexus-session-store.js";
// nexus surface store
export type {
  NexusSurfaceStoreHandle,
  NexusSurfaceStoreOptions,
} from "./nexus-surface-store.js";
export { createNexusSurfaceStore } from "./nexus-surface-store.js";

// poll sync
export type { PollSyncConfig, PollSyncHandle } from "./poll-sync.js";
export { createPollSync } from "./poll-sync.js";
// write queue
export type { WriteQueue } from "./write-queue.js";
export { createWriteQueue } from "./write-queue.js";
