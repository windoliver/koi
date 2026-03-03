/**
 * @koi/events-nexus — Nexus-backed EventBackend (Layer 2)
 *
 * Provides a durable, multi-node event backend that stores events
 * on a Nexus filesystem via JSON-RPC 2.0. Suitable for distributed
 * deployments where multiple Koi nodes share event-sourced state.
 */

export type { NexusEventBackendConfig } from "./nexus-backend.js";
export { createNexusEventBackend } from "./nexus-backend.js";
