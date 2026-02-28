/**
 * @koi/registry-nexus — Nexus-backed AgentRegistry (Layer 2)
 *
 * Provides a Nexus-backed implementation of the AgentRegistry contract.
 * Nexus is the source of truth; local projection cache is kept in sync
 * via periodic polling.
 */

export { createNexusRegistryProvider } from "./component-provider.js";
export type { FetchFn, NexusRegistryConfig } from "./config.js";
export { DEFAULT_NEXUS_REGISTRY_CONFIG, validateNexusRegistryConfig } from "./config.js";
export { discoverBySkill } from "./discovery.js";
export type { NexusAgent } from "./nexus-client.js";
export { nexusRpc } from "./nexus-client.js";
export { createNexusRegistry } from "./nexus-registry.js";
export { mapKoiToNexus, mapNexusToKoi } from "./state-mapping.js";
