/**
 * @koi/search-nexus — Nexus search REST adapter (Layer 2)
 *
 * Pluggable backend for @koi/search using Nexus search API v2.
 */

export { mapNexusHttpError } from "./http-errors.js";
export { mapNexusResult } from "./map-nexus-result.js";
export { createNexusIndexer } from "./nexus-indexer.js";
export { createNexusRetriever } from "./nexus-retriever.js";
export type { FetchFn, NexusSearchConfig } from "./nexus-search-config.js";
export { DEFAULT_TIMEOUT_MS } from "./nexus-search-config.js";
