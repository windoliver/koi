/**
 * @koi/gateway-nexus — Nexus-backed gateway SessionStore (L2).
 *
 * Provides a write-through SessionStore implementation backed by Nexus for
 * multi-instance HA gateway deployment. The interface itself is the L0u
 * SessionStore from @koi/gateway-types so any gateway L2 package (notably
 * @koi/gateway and @koi/gateway-stack) can inject this store without
 * creating an L2→L2 dependency.
 */

export type {
  DegradationConfig,
  GatewayNexusConfig,
  WriteQueueConfig,
} from "./config.js";
export {
  DEFAULT_BASE_PATH,
  DEFAULT_DEGRADATION_CONFIG,
  DEFAULT_WRITE_QUEUE_CONFIG,
  validateGatewayNexusConfig,
} from "./config.js";
export type { DegradationMode, DegradationState } from "./degradation.js";
export {
  createDegradationState,
  recordFailure,
  recordSuccess,
  shouldProbe,
} from "./degradation.js";
export type {
  NexusSessionStoreHandle,
  NexusSessionStoreOptions,
} from "./nexus-session-store.js";
export { createNexusSessionStore } from "./nexus-session-store.js";
export type { WriteQueue } from "./write-queue.js";
export { createWriteQueue } from "./write-queue.js";
