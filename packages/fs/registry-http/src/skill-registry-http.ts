/**
 * HTTP-backed SkillRegistryBackend implementation.
 *
 * Reads are cache-first with LRU + TTL. Write operations always require network.
 * Search propagates network failures to the caller.
 */

import type {
  KoiError,
  Result,
  SkillArtifact,
  SkillId,
  SkillPage,
  SkillPublishRequest,
  SkillRegistryBackend,
  SkillRegistryEntry,
  SkillSearchQuery,
  SkillVersion,
} from "@koi/core";
import { DEFAULT_SKILL_SEARCH_LIMIT } from "@koi/core";
import type { LruCache } from "./cache.js";
import { createLruCache } from "./cache.js";
import type { RegistryHttpConfig } from "./config.js";
import { DEFAULT_CACHE_TTL_MS, DEFAULT_MAX_CACHE_ENTRIES, DEFAULT_TIMEOUT_MS } from "./config.js";
import type { HttpClientConfig } from "./http-client.js";
import { httpRequest } from "./http-client.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an HTTP-backed skill registry backend.
 *
 * Implements the full SkillRegistryBackend interface (read + write).
 * GET responses are cached in an LRU cache with configurable TTL.
 */
export function createSkillRegistryHttp(config: RegistryHttpConfig): SkillRegistryBackend {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const client: HttpClientConfig = {
    baseUrl: config.baseUrl,
    authToken: config.authToken,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetch: fetchFn,
  };

  const cache: LruCache<SkillRegistryEntry> = createLruCache(
    config.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES,
    config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
  );

  // ---------------------------------------------------------------------------
  // Reader methods
  // ---------------------------------------------------------------------------

  const search = async (query: SkillSearchQuery): Promise<SkillPage> => {
    const params = new URLSearchParams();
    if (query.text !== undefined) params.set("text", query.text);
    if (query.tags !== undefined && query.tags.length > 0) {
      params.set("tags", query.tags.join(","));
    }
    if (query.author !== undefined) params.set("author", query.author);
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    params.set("limit", String(query.limit ?? DEFAULT_SKILL_SEARCH_LIMIT));

    const qs = params.toString();
    const path = `/skills${qs.length > 0 ? `?${qs}` : ""}`;

    const result = await httpRequest<SkillPage>(client, "GET", path);

    if (!result.ok) {
      throw new Error(`Skill registry search failed: ${result.error.message}`, {
        cause: result.error,
      });
    }

    // Cache individual entries from search results
    for (const item of result.value.items) {
      cache.set(item.id, item);
    }

    return result.value;
  };

  const get = async (id: SkillId): Promise<Result<SkillRegistryEntry, KoiError>> => {
    // Cache-first read
    const cached = cache.get(id);
    if (cached !== undefined) {
      return { ok: true, value: cached };
    }

    const result = await httpRequest<SkillRegistryEntry>(
      client,
      "GET",
      `/skills/${encodeURIComponent(id)}`,
    );
    if (result.ok) {
      cache.set(id, result.value);
    }
    return result;
  };

  const versions = async (id: SkillId): Promise<Result<readonly SkillVersion[], KoiError>> => {
    return httpRequest<readonly SkillVersion[]>(
      client,
      "GET",
      `/skills/${encodeURIComponent(id)}/versions`,
    );
  };

  const install = async (
    id: SkillId,
    version?: string,
  ): Promise<Result<SkillArtifact, KoiError>> => {
    const params = version !== undefined ? `?version=${encodeURIComponent(version)}` : "";
    return httpRequest<SkillArtifact>(
      client,
      "GET",
      `/skills/${encodeURIComponent(id)}/install${params}`,
    );
  };

  // ---------------------------------------------------------------------------
  // Writer methods
  // ---------------------------------------------------------------------------

  const publish = async (
    request: SkillPublishRequest,
  ): Promise<Result<SkillRegistryEntry, KoiError>> => {
    const result = await httpRequest<SkillRegistryEntry>(client, "POST", "/skills", request);
    if (result.ok) {
      cache.set(request.id, result.value);
    }
    return result;
  };

  const unpublish = async (id: SkillId): Promise<Result<void, KoiError>> => {
    const result = await httpRequest<void>(client, "DELETE", `/skills/${encodeURIComponent(id)}`);
    if (result.ok) {
      cache.delete(id);
    }
    return result;
  };

  const deprecate = async (id: SkillId, version: string): Promise<Result<void, KoiError>> => {
    const result = await httpRequest<void>(
      client,
      "POST",
      `/skills/${encodeURIComponent(id)}/deprecate`,
      { version },
    );
    if (result.ok) {
      // Invalidate cached entry since it may have stale version info
      cache.delete(id);
    }
    return result;
  };

  return { search, get, versions, install, publish, unpublish, deprecate };
}
