/**
 * @koi/nexus-store — Unified Nexus-backed persistence for all Koi storage contracts.
 *
 * L2 package. Consolidates Nexus adapters for ForgeStore, EventBackend,
 * SnapshotChainStore, SessionPersistence, and MemoryPersistence into a
 * single package with subpath exports.
 *
 * Import from subpaths for tree-shaking:
 *   import { createNexusForgeStore } from "@koi/nexus-store/forge.js"
 *   import { createNexusEventBackend } from "@koi/nexus-store/events.js"
 *   import { createNexusSnapshotStore } from "@koi/nexus-store/snapshots.js"
 *   import { createNexusSessionStore } from "@koi/nexus-store/session.js"
 *   import { createNexusMemoryBackend } from "@koi/nexus-store/memory.js"
 */

export type {
  NexusAceStoreConfig,
  NexusPlaybookStore,
  NexusStructuredPlaybookStore,
  NexusTrajectoryStore,
} from "./ace.js";
export {
  createNexusPlaybookStore,
  createNexusStructuredPlaybookStore,
  createNexusTrajectoryStore,
} from "./ace.js";
export type { NexusEventBackendConfig } from "./events.js";
export { createNexusEventBackend } from "./events.js";
export type { NexusForgeStoreConfig } from "./forge.js";
export { createNexusForgeStore } from "./forge.js";
export type { MemoryFact, MemoryPersistenceBackend, NexusMemoryBackendConfig } from "./memory.js";
export { createNexusMemoryBackend } from "./memory.js";
export type { NexusSessionStoreConfig } from "./session.js";
export { createNexusSessionStore } from "./session.js";
export type { NexusSnapshotStoreConfig } from "./snapshots.js";
export { createNexusSnapshotStore } from "./snapshots.js";
