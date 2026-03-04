/**
 * @koi/registry-memory — In-memory AgentRegistry backed by EventBackend (Layer 2)
 *
 * Provides an in-memory implementation of the AgentRegistry contract.
 * Events are the source of truth; current state is a derived projection.
 */
export type { MemoryRegistry } from "./memory-registry.js";
export { createMemoryRegistry } from "./memory-registry.js";
export { agentStreamId, parseAgentStreamId, REGISTRY_INDEX_STREAM } from "./stream-ids.js";
