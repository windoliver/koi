/**
 * ContextHubExecutor — injectable backend for Context Hub search and fetch.
 *
 * Fetches registry + docs from Context Hub's CDN (default: cdn.aichub.org/v1).
 * Implements BM25 search locally against the registry's search index.
 *
 * L2 — imports from @koi/core only.
 */

import type { KoiError, Result } from "@koi/core";
import { buildSearchIndex, type SearchIndex, type SearchIndexEntry, searchIndex } from "./bm25.js";

// ---------------------------------------------------------------------------
// Registry types (validated at parse boundary)
// ---------------------------------------------------------------------------

export interface RegistryDocVersion {
  readonly version: string;
  readonly path: string;
  readonly size: number;
  readonly lastUpdated: string;
}

export interface RegistryDocLanguage {
  readonly language: string;
  readonly versions: readonly RegistryDocVersion[];
  readonly recommendedVersion: string;
}

export interface RegistryDoc {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly tags: readonly string[];
  readonly languages: readonly RegistryDocLanguage[];
}

export interface Registry {
  readonly version: string;
  readonly docs: readonly RegistryDoc[];
  readonly base_url: string;
}

// ---------------------------------------------------------------------------
// Search result type
// ---------------------------------------------------------------------------

export interface ChubSearchResult {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly source: string;
  readonly languages: readonly {
    readonly language: string;
    readonly recommendedVersion: string;
    readonly size: number;
    readonly lastUpdated: string;
  }[];
}

// ---------------------------------------------------------------------------
// Get result type
// ---------------------------------------------------------------------------

export interface ChubGetResult {
  readonly id: string;
  readonly content: string;
  readonly language: string;
  readonly version: string;
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Executor interface
// ---------------------------------------------------------------------------

export interface ContextHubExecutor {
  readonly search: (
    query: string,
    maxResults?: number,
  ) => Promise<Result<readonly ChubSearchResult[], KoiError>>;
  readonly get: (
    id: string,
    language?: string,
    version?: string,
  ) => Promise<Result<ChubGetResult, KoiError>>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ContextHubExecutorConfig {
  /** Custom fetch function (default: globalThis.fetch). */
  readonly fetchFn?:
    | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
    | undefined;
  /** CDN base URL (default: https://cdn.aichub.org/v1). */
  readonly baseUrl?: string | undefined;
  /** Cache TTL in ms (default: 21_600_000 — 6 hours, matching Context Hub). */
  readonly cacheTtlMs?: number | undefined;
  /** Max cache entries for doc content (default: 100). */
  readonly maxCacheEntries?: number | undefined;
  /** Max doc body size in characters (default: 50_000). */
  readonly maxBodyChars?: number | undefined;
  /** Request timeout in ms (default: 15_000). */
  readonly timeoutMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_BASE_URL = "https://cdn.aichub.org/v1";
export const DEFAULT_CACHE_TTL_MS = 21_600_000; // 6 hours
export const DEFAULT_MAX_CACHE_ENTRIES = 100;
export const DEFAULT_MAX_BODY_CHARS = 50_000;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_SEARCH_RESULTS = 10;

// ---------------------------------------------------------------------------
// LRU cache (reusable helper — same pattern as @koi/tools-web)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

function createCache<T>(
  maxEntries: number,
  ttlMs: number,
): {
  readonly get: (key: string) => T | undefined;
  readonly set: (key: string, value: T) => void;
  readonly size: () => number;
} {
  const map = new Map<string, CacheEntry<T>>();

  return {
    get: (key: string): T | undefined => {
      const entry = map.get(key);
      if (entry === undefined) return undefined;
      if (Date.now() > entry.expiresAt) {
        map.delete(key);
        return undefined;
      }
      // Refresh LRU position
      map.delete(key);
      map.set(key, entry);
      return entry.value;
    },
    set: (key: string, value: T): void => {
      map.delete(key);
      if (map.size >= maxEntries) {
        const oldest = map.keys().next();
        if (!oldest.done) map.delete(oldest.value);
      }
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    size: () => map.size,
  };
}

// ---------------------------------------------------------------------------
// Registry parsing (validate at boundary)
// ---------------------------------------------------------------------------

function parseRegistryDoc(raw: unknown): RegistryDoc | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.name !== "string") return undefined;

  const languages: RegistryDocLanguage[] = [];
  if (Array.isArray(obj.languages)) {
    for (const lang of obj.languages) {
      if (typeof lang !== "object" || lang === null) continue;
      const l = lang as Record<string, unknown>;
      if (typeof l.language !== "string") continue;

      const versions: RegistryDocVersion[] = [];
      if (Array.isArray(l.versions)) {
        for (const ver of l.versions) {
          if (typeof ver !== "object" || ver === null) continue;
          const v = ver as Record<string, unknown>;
          if (typeof v.version !== "string" || typeof v.path !== "string") continue;
          versions.push({
            version: v.version,
            path: v.path,
            size: typeof v.size === "number" ? v.size : 0,
            lastUpdated: typeof v.lastUpdated === "string" ? v.lastUpdated : "",
          });
        }
      }

      languages.push({
        language: l.language,
        versions,
        recommendedVersion:
          typeof l.recommendedVersion === "string"
            ? l.recommendedVersion
            : (versions[0]?.version ?? ""),
      });
    }
  }

  const tags: string[] = [];
  if (Array.isArray(obj.tags)) {
    for (const tag of obj.tags) {
      if (typeof tag === "string") tags.push(tag);
    }
  }

  return {
    id: obj.id,
    name: obj.name,
    description: typeof obj.description === "string" ? obj.description : "",
    source: typeof obj.source === "string" ? obj.source : "community",
    tags,
    languages,
  };
}

function parseRegistry(raw: unknown): Result<Registry, KoiError> {
  if (typeof raw !== "object" || raw === null) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Registry schema mismatch: response is not a JSON object",
        retryable: false,
      },
    };
  }

  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "string" || !Array.isArray(obj.docs)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Registry schema mismatch: missing required fields (version, docs)",
        retryable: false,
      },
    };
  }

  const docs: RegistryDoc[] = [];
  for (const raw_doc of obj.docs) {
    const doc = parseRegistryDoc(raw_doc);
    if (doc !== undefined) docs.push(doc);
  }

  return {
    ok: true,
    value: {
      version: obj.version,
      docs,
      base_url: typeof obj.base_url === "string" ? obj.base_url : DEFAULT_BASE_URL,
    },
  };
}

// ---------------------------------------------------------------------------
// Doc path resolution
// ---------------------------------------------------------------------------

function resolveDocPath(
  doc: RegistryDoc,
  language?: string,
  version?: string,
): Result<
  { readonly path: string; readonly language: string; readonly version: string },
  KoiError
> {
  if (doc.languages.length === 0) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Doc "${doc.id}" has no language variants`,
        retryable: false,
      },
    };
  }

  // Find language variant
  const lang =
    language !== undefined
      ? doc.languages.find((l) => l.language.toLowerCase() === language.toLowerCase())
      : doc.languages.length === 1
        ? doc.languages[0]
        : undefined;

  if (lang === undefined) {
    const available = doc.languages.map((l) => l.language);
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message:
          language !== undefined
            ? `Language "${language}" not found for "${doc.id}". Available: ${available.join(", ")}`
            : `Multiple languages available for "${doc.id}": ${available.join(", ")}. Specify one with the language parameter.`,
        retryable: false,
      },
    };
  }

  // Find version
  const ver =
    version !== undefined
      ? lang.versions.find((v) => v.version === version)
      : (lang.versions.find((v) => v.version === lang.recommendedVersion) ?? lang.versions[0]);

  if (ver === undefined) {
    const available = lang.versions.map((v) => v.version);
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Version "${version}" not found for "${doc.id}" (${lang.language}). Available: ${available.join(", ")}`,
        retryable: false,
      },
    };
  }

  return { ok: true, value: { path: ver.path, language: lang.language, version: ver.version } };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ContextHubExecutor backed by CDN fetch and local BM25 search.
 *
 * Side-effect: makes HTTP requests to Context Hub CDN.
 */
export function createContextHubExecutor(
  config: ContextHubExecutorConfig = {},
): ContextHubExecutor {
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxCacheEntries = config.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const maxBodyChars = config.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const docCache = createCache<string>(maxCacheEntries, cacheTtlMs);

  // Registry + search index: loaded lazily, cached in closure.
  // searchIndexCache is invalidated whenever loadRegistry() fetches a fresh copy.
  let registryCache: { readonly registry: Registry; readonly expiresAt: number } | undefined;
  let searchIndexCache: SearchIndex | undefined;

  // -------------------------------------------------------------------------
  // Internal: fetch with timeout
  // -------------------------------------------------------------------------

  async function fetchWithTimeout(url: string): Promise<Result<Response, KoiError>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(url, { signal: controller.signal });
      clearTimeout(timer);
      return { ok: true, value: response };
    } catch (e: unknown) {
      clearTimeout(timer);
      const message = e instanceof Error ? e.message : String(e);
      const isTimeout = message.includes("abort") || message.includes("timeout");
      return {
        ok: false,
        error: {
          code: isTimeout ? "TIMEOUT" : "EXTERNAL",
          message: `Failed to fetch ${url}: ${message}`,
          retryable: true,
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // Internal: load registry (cached)
  // -------------------------------------------------------------------------

  async function loadRegistry(): Promise<Result<Registry, KoiError>> {
    if (registryCache !== undefined && Date.now() < registryCache.expiresAt) {
      return { ok: true, value: registryCache.registry };
    }

    const result = await fetchWithTimeout(`${baseUrl}/registry.json`);
    if (!result.ok) return result;

    const response = result.value;
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Registry unavailable: HTTP ${response.status}`,
          retryable: response.status >= 500,
        },
      };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "Registry unavailable: response is not valid JSON",
          retryable: false,
        },
      };
    }

    const parsed = parseRegistry(json);
    if (!parsed.ok) return parsed;

    registryCache = { registry: parsed.value, expiresAt: Date.now() + cacheTtlMs };
    searchIndexCache = undefined; // Invalidate — content may have changed
    return parsed;
  }

  // -------------------------------------------------------------------------
  // Internal: load search index (lazy, built from registry)
  // -------------------------------------------------------------------------

  function buildIndex(registry: Registry): SearchIndex {
    const entries: SearchIndexEntry[] = registry.docs.map((doc) => ({
      id: doc.id,
      fields: {
        name: doc.name,
        description: doc.description,
        tags: doc.tags.join(" "),
      },
    }));
    return buildSearchIndex(entries);
  }

  // -------------------------------------------------------------------------
  // search()
  // -------------------------------------------------------------------------

  async function search(
    query: string,
    maxResults?: number,
  ): Promise<Result<readonly ChubSearchResult[], KoiError>> {
    const registryResult = await loadRegistry();
    if (!registryResult.ok) return registryResult;

    const registry = registryResult.value;

    // Rebuild search index on first load or after registry refresh (loadRegistry
    // sets searchIndexCache = undefined whenever it fetches a fresh registry).
    if (searchIndexCache === undefined) {
      searchIndexCache = buildIndex(registry);
    }

    const limit = maxResults ?? DEFAULT_MAX_SEARCH_RESULTS;
    const hits = searchIndex(searchIndexCache, query, limit);

    // Map BM25 hits to rich search results
    const docMap = new Map(registry.docs.map((d) => [d.id, d]));
    const results: ChubSearchResult[] = [];

    for (const hit of hits) {
      const doc = docMap.get(hit.id);
      if (doc === undefined) continue;

      results.push({
        id: doc.id,
        name: doc.name,
        description: doc.description,
        tags: doc.tags,
        source: doc.source,
        languages: doc.languages.map((l) => {
          const recommended =
            l.versions.find((v) => v.version === l.recommendedVersion) ?? l.versions[0];
          return {
            language: l.language,
            recommendedVersion: l.recommendedVersion,
            size: recommended?.size ?? 0,
            lastUpdated: recommended?.lastUpdated ?? "",
          };
        }),
      });
    }

    return { ok: true, value: results };
  }

  // -------------------------------------------------------------------------
  // get()
  // -------------------------------------------------------------------------

  async function get(
    id: string,
    language?: string,
    version?: string,
  ): Promise<Result<ChubGetResult, KoiError>> {
    const registryResult = await loadRegistry();
    if (!registryResult.ok) return registryResult;

    const registry = registryResult.value;
    const doc = registry.docs.find((d) => d.id === id);
    if (doc === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Doc "${id}" not found in registry`,
          retryable: false,
        },
      };
    }

    const pathResult = resolveDocPath(doc, language, version);
    if (!pathResult.ok) return pathResult;

    const { path, language: resolvedLang, version: resolvedVersion } = pathResult.value;
    const docUrl = `${registry.base_url}/${path}`;
    const cacheKey = `${id}:${resolvedLang}:${resolvedVersion}`;

    // Check doc cache
    const cached = docCache.get(cacheKey);
    if (cached !== undefined) {
      const truncated = cached.length > maxBodyChars;
      return {
        ok: true,
        value: {
          id,
          content: truncated ? cached.slice(0, maxBodyChars) : cached,
          language: resolvedLang,
          version: resolvedVersion,
          truncated,
        },
      };
    }

    // Fetch doc content
    const fetchResult = await fetchWithTimeout(docUrl);
    if (!fetchResult.ok) return fetchResult;

    const response = fetchResult.value;
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: response.status === 404 ? "NOT_FOUND" : "EXTERNAL",
          message: `Doc fetch returned HTTP ${response.status} for "${id}"`,
          retryable: response.status >= 500,
        },
      };
    }

    let body: string;
    try {
      body = await response.text();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Failed to read doc body: ${message}`,
          retryable: true,
        },
      };
    }

    // Cache full body, truncate on read
    docCache.set(cacheKey, body);

    const truncated = body.length > maxBodyChars;
    return {
      ok: true,
      value: {
        id,
        content: truncated ? body.slice(0, maxBodyChars) : body,
        language: resolvedLang,
        version: resolvedVersion,
        truncated,
      },
    };
  }

  return { search, get };
}
