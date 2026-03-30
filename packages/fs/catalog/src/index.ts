/**
 * @koi/catalog — Unified Capability Discovery (Layer 2)
 *
 * Provides a single CatalogReader that searches across bundled packages,
 * forged bricks, MCP tools, and skill-registry entries. Agents use the
 * search_catalog and attach_capability tools to discover and activate
 * capabilities at runtime.
 *
 * Depends on @koi/core only — never on L1 or peer L2 packages.
 */

// Re-export L0 types used by this package
export type {
  CatalogEntry,
  CatalogPage,
  CatalogQuery,
  CatalogReader,
  CatalogSource,
  CatalogSourceError,
} from "@koi/core";
// Source adapters
export {
  createBundledAdapter,
  createForgeAdapter,
  createMcpAdapter,
  createSkillAdapter,
} from "./adapters.js";
// Agent resolver
export type { CatalogAgentResolverConfig } from "./agent-resolver.js";
export { createCatalogAgentResolver } from "./agent-resolver.js";
// Bundled catalog data
export { BUNDLED_ENTRIES } from "./bundled-entries.js";
export type { TtlCache } from "./cache.js";
// Utilities
export { createTtlCache } from "./cache.js";

// Resolver factory
export { createCatalogResolver } from "./catalog-resolver.js";
export type { CatalogProviderConfig } from "./component-provider.js";
// Component provider factory
export { createCatalogComponentProvider } from "./component-provider.js";
export { fanOut } from "./fan-out.js";
// Tool registration (self-describing registration descriptor)
export { createCatalogRegistration } from "./registration.js";
export type { AttachConfig } from "./tools/attach-capability.js";
export { createAttachCapabilityTool } from "./tools/attach-capability.js";
// Tool factories (for direct use without ComponentProvider)
export { createSearchCatalogTool } from "./tools/search-catalog.js";
// Internal types
export type { CatalogResolverConfig, CatalogSourceAdapter } from "./types.js";
