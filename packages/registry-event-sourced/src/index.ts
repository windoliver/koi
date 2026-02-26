/**
 * @koi/registry-event-sourced — Event-sourced AgentRegistry (Layer 2)
 *
 * Provides an event-sourced implementation of the AgentRegistry contract.
 * Events are the source of truth; current state is a derived projection.
 */
export type { EventSourcedRegistry } from "./event-sourced-registry.js";
export { createEventSourcedRegistry } from "./event-sourced-registry.js";
export { agentStreamId, parseAgentStreamId, REGISTRY_INDEX_STREAM } from "./stream-ids.js";
