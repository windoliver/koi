/**
 * @koi/registry-store — SQLite-backed BrickRegistry, SkillRegistry, and VersionIndex.
 *
 * Provides persistent implementations of the three L0 registry contracts
 * using bun:sqlite with FTS5 full-text search, keyset cursor pagination,
 * and onChange event dispatch.
 */

export type { SqliteBrickRegistry } from "./brick-registry.js";
export { createSqliteBrickRegistry } from "./brick-registry.js";
export type {
  RegistryStoreConfig,
  RegistryStoreDbConfig,
  RegistryStorePathConfig,
} from "./config.js";
export type { RegistryProviderConfig } from "./registry-component-provider.js";
export { createRegistryProvider } from "./registry-component-provider.js";
export type { SqliteSkillRegistry } from "./skill-registry.js";
export { createSqliteSkillRegistry } from "./skill-registry.js";
export type { SqliteVersionIndex } from "./version-index.js";
export { createSqliteVersionIndex } from "./version-index.js";
