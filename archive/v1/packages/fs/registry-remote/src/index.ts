/**
 * @koi/registry-remote — Remote HTTP registry client for community brick marketplace.
 *
 * L2 package: depends on @koi/core, @koi/errors, and @koi/forge-types.
 */

// dependency check — validate brick requirements
export { checkBrickDependencies } from "./dependency-check.js";
// HTTP cache — ETag/304 + TTL in-memory cache
export type { HttpCache, HttpCacheConfig } from "./http-cache.js";
export { createHttpCache } from "./http-cache.js";
// publish — standalone publish function
export { publishBrick } from "./publish.js";
// remote registry client — BrickRegistryReader over HTTP
export type { RemoteRegistryClient } from "./remote-registry.js";
export { createRemoteRegistry } from "./remote-registry.js";

// types — configuration, results, and data types
export type {
  BatchCheckResult,
  CachedResponse,
  DependencyCheckResult,
  IntegrityCheckResult,
  IntegrityVerifier,
  MissingDependency,
  PublishOptions,
  PublishResult,
  RemoteRegistryConfig,
} from "./types.js";
export {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_CACHE_ENTRIES,
  DEFAULT_PUBLISH_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
} from "./types.js";
