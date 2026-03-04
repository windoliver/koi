/**
 * @koi/name-service-nexus — Nexus-backed ANS backend (Layer 2)
 *
 * Provides a Nexus-backed implementation of the NameServiceBackend contract.
 * Nexus is the source of truth; local projection cache is kept in sync
 * via periodic polling.
 */

export type { FetchFn, NexusNameServiceConfig } from "./config.js";
export { DEFAULT_NEXUS_NAME_SERVICE_CONFIG, validateNexusNameServiceConfig } from "./config.js";
export { createNexusNameService } from "./nexus-name-service.js";
export type { NexusNameRecord } from "./nexus-rpc.js";
