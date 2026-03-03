/**
 * @koi/search-nexus — Nexus search REST adapter (Layer 2)
 *
 * Pluggable backend for @koi/search using Nexus search API v2.
 */

export { mapNexusResult } from "./map-nexus-result.js";
export { createNexusSearch } from "./nexus-search.js";
export type { FetchFn, NexusSearchConfig } from "./nexus-search-config.js";
export {
  DEFAULT_LIMIT,
  DEFAULT_MAX_BATCH_SIZE,
  DEFAULT_TIMEOUT_MS,
} from "./nexus-search-config.js";
export type { NexusSearch, SearchHealth, SearchStats } from "./nexus-search-types.js";
export { validateNexusSearchConfig } from "./validate-config.js";
