/**
 * @koi/registry-http — HTTP-backed skill registry (Layer 2)
 *
 * Implements SkillRegistryBackend from @koi/core over REST.
 * Cache-first reads with LRU + TTL. Fail-open search.
 * Write operations always require network.
 *
 * Depends on @koi/core only.
 */

export type { LruCache } from "./cache.js";
export { createLruCache } from "./cache.js";
export type { RegistryHttpConfig } from "./config.js";
export {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_CACHE_ENTRIES,
  DEFAULT_TIMEOUT_MS,
} from "./config.js";
export { mapHttpError, mapNetworkError } from "./errors.js";
export type { HttpClientConfig } from "./http-client.js";
export { httpRequest } from "./http-client.js";
export { createSkillRegistryHttp } from "./skill-registry-http.js";
