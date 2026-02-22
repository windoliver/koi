/**
 * @koi/artifact-client — Persistent artifact storage (Layer 2)
 *
 * Provides a universal ArtifactClient interface with pluggable backends
 * (InMemory, Nexus) and an optional LRU cache wrapper.
 */

// Composition
export type { CacheOptions } from "./cached-client.js";
export { createCachedArtifactClient } from "./cached-client.js";

// Interface
export type { ArtifactClient } from "./client.js";
// Utilities
export { computeContentHash } from "./hash.js";
// Implementations
export { createInMemoryArtifactStore } from "./memory-store.js";
export type { NexusStoreConfig } from "./nexus-store.js";
export { createNexusArtifactStore } from "./nexus-store.js";
export type { SqliteStoreConfig } from "./sqlite-store.js";
export { createSqliteArtifactStore } from "./sqlite-store.js";
// Types
export type {
  Artifact,
  ArtifactId,
  ArtifactPage,
  ArtifactQuery,
  ArtifactUpdate,
  ContentHash,
} from "./types.js";
export { artifactId, contentHash } from "./types.js";
