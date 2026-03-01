/**
 * @koi/store-nexus — Nexus-backed ForgeStore for multi-node deployments.
 *
 * Stores bricks as JSON files on a Nexus server via JSON-RPC.
 * Depends on @koi/core (L0), @koi/nexus-client (L0u), and @koi/validation (L0u).
 */

export type { NexusForgeStoreConfig } from "./nexus-store.js";
export { createNexusForgeStore } from "./nexus-store.js";
