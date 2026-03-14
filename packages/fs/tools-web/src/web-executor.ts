/**
 * WebExecutor — injectable backend for web fetch and search operations.
 *
 * Abstracts HTTP fetching and web search so both can be mocked in tests
 * and swapped for different backends (Brave, Google, SerpAPI, etc.).
 */

import type { KoiError, Result } from "@koi/core";
import type { SearchProvider, WebSearchOptions, WebSearchResult } from "@koi/search-provider";
import type { DnsResolverFn } from "./url-policy.js";
import { isBlockedUrl, resolveAndValidateUrl } from "./url-policy.js";

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface WebFetchOptions {
  readonly method?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface WebFetchResult {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly truncated: boolean;
  /** Final URL after redirects (may differ from requested URL). */
  readonly finalUrl: string;
}

// ---------------------------------------------------------------------------
// Search — canonical types re-exported from @koi/search-provider
// ---------------------------------------------------------------------------

export type { WebSearchOptions, WebSearchResult } from "@koi/search-provider";

// ---------------------------------------------------------------------------
// Executor interface
// ---------------------------------------------------------------------------

export interface WebExecutor {
  readonly fetch: (
    url: string,
    options?: WebFetchOptions,
  ) => Promise<Result<WebFetchResult, KoiError>>;
  readonly search: (
    query: string,
    options?: WebSearchOptions,
  ) => Promise<Result<readonly WebSearchResult[], KoiError>>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WebExecutorConfig {
  /** Custom fetch function (default: globalThis.fetch). */
  readonly fetchFn?: typeof globalThis.fetch | undefined;
  /** Custom DNS resolver for pre-flight SSRF validation (default: Bun.dns.resolve). */
  readonly dnsResolver?: DnsResolverFn | undefined;
  /**
   * @deprecated Use `searchProvider` instead. Kept for backward compatibility.
   * Custom search backend function. If both `searchProvider` and `searchFn` are set,
   * `searchProvider` takes precedence.
   */
  readonly searchFn?:
    | ((
        query: string,
        options?: WebSearchOptions,
      ) => Promise<Result<readonly WebSearchResult[], KoiError>>)
    | undefined;
  /** Pluggable search provider (preferred over searchFn). */
  readonly searchProvider?: SearchProvider | undefined;
  /** Max response body size in characters (default: 50_000). */
  readonly maxBodyChars?: number | undefined;
  /** Default timeout in ms (default: 15_000). */
  readonly defaultTimeoutMs?: number | undefined;
  /** Cache TTL in ms. Set to 0 to disable caching (default: 0 — disabled). */
  readonly cacheTtlMs?: number | undefined;
  /** Max cache entries (default: 100). */
  readonly maxCacheEntries?: number | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_BODY_CHARS = 50_000;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 60_000;
export const DEFAULT_CACHE_TTL_MS = 0;
export const DEFAULT_MAX_CACHE_ENTRIES = 100;
export const MAX_REDIRECTS = 10;

const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Headers stripped on cross-origin redirects per RFC 7231 / browser behavior.
 * Prevents credential leakage when a redirect crosses origin boundaries.
 */
const CROSS_ORIGIN_SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-amz-security-token",
  "x-auth-token",
  "x-csrf-token",
  "x-forwarded-for",
]);

// ---------------------------------------------------------------------------
// Internal cache (LRU + TTL)
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
        // Evict oldest (first entry)
        const oldest = map.keys().next();
        if (!oldest.done) map.delete(oldest.value);
      }
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a WebExecutor backed by the platform `fetch` API.
 *
 * Side-effect: makes HTTP requests when `fetch()` is called.
 * Search requires a `searchFn` in config — returns VALIDATION error without one.
 */
export function createWebExecutor(config: WebExecutorConfig = {}): WebExecutor {
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  const dnsResolver = config.dnsResolver;
  const maxBodyChars = config.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const defaultTimeout = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxCacheEntries = config.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;

  const fetchCache =
    cacheTtlMs > 0 ? createCache<WebFetchResult>(maxCacheEntries, cacheTtlMs) : undefined;
  const searchCache =
    cacheTtlMs > 0
      ? createCache<readonly WebSearchResult[]>(maxCacheEntries, cacheTtlMs)
      : undefined;

  return {
    fetch: async (
      url: string,
      options?: WebFetchOptions,
    ): Promise<Result<WebFetchResult, KoiError>> => {
      const method = options?.method ?? "GET";
      // Normalize URL to canonical form to prevent cache key collisions
      // from semantically identical URLs with different encodings
      const normalizedUrl = (() => {
        try {
          return new URL(url).href;
        } catch {
          return url;
        }
      })();
      const cacheKey = `${method}:${normalizedUrl}`;

      // Check cache (GET/HEAD only)
      if (fetchCache !== undefined && (method === "GET" || method === "HEAD")) {
        const cached = fetchCache.get(cacheKey);
        if (cached !== undefined) return { ok: true, value: cached };
      }

      const timeout = Math.min(options?.timeoutMs ?? defaultTimeout, MAX_TIMEOUT_MS);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        // Forward external signal
        if (options?.signal) {
          if (options.signal.aborted) {
            clearTimeout(timer);
            return {
              ok: false,
              error: { code: "TIMEOUT", message: "Request aborted", retryable: false },
            };
          }
          options.signal.addEventListener("abort", () => controller.abort(), { once: true });
        }

        // DNS rebinding mitigation: resolve and validate the initial URL's IP
        const dnsResult = await resolveAndValidateUrl(url, dnsResolver);
        if (dnsResult.blocked) {
          clearTimeout(timer);
          return {
            ok: false,
            error: {
              code: "PERMISSION",
              message: `DNS validation blocked: ${dnsResult.reason}`,
              retryable: false,
            },
          };
        }

        // Manual redirect loop: validate each redirect URL BEFORE following it
        let currentUrl = url;
        let currentMethod = method;
        let currentHeaders: Readonly<Record<string, string>> | undefined = options?.headers;
        let currentBody = options?.body;
        let response: Response | undefined;

        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          response = await fetchFn(currentUrl, {
            method: currentMethod,
            headers: currentHeaders,
            body: currentBody,
            signal: controller.signal,
            redirect: "manual",
          });

          if (!REDIRECT_STATUS_CODES.has(response.status)) break;

          const location = response.headers.get("location");
          if (location === null || location === "") break;

          // Resolve relative redirect URLs against the current URL
          const nextUrl = new URL(location, currentUrl).href;

          // Validate redirect target BEFORE following it (string-based first pass)
          if (isBlockedUrl(nextUrl)) {
            clearTimeout(timer);
            return {
              ok: false,
              error: {
                code: "PERMISSION",
                message: `Redirect to private/internal URL blocked: ${nextUrl}`,
                retryable: false,
              },
            };
          }

          // DNS rebinding mitigation: resolve and validate redirect target's IP
          const redirectDns = await resolveAndValidateUrl(nextUrl, dnsResolver);
          if (redirectDns.blocked) {
            clearTimeout(timer);
            return {
              ok: false,
              error: {
                code: "PERMISSION",
                message: `Redirect DNS validation blocked: ${redirectDns.reason}`,
                retryable: false,
              },
            };
          }

          // Strip sensitive headers on cross-origin redirects (RFC 7231 / browser behavior)
          if (currentHeaders !== undefined) {
            const currentOrigin = new URL(currentUrl).origin;
            const nextOrigin = new URL(nextUrl).origin;
            if (currentOrigin !== nextOrigin) {
              currentHeaders = Object.fromEntries(
                Object.entries(currentHeaders).filter(
                  ([k]) => !CROSS_ORIGIN_SENSITIVE_HEADERS.has(k.toLowerCase()),
                ),
              );
            }
          }

          currentUrl = nextUrl;

          // 303 always converts to GET with no body; 301/302 convert to GET for
          // non-GET/HEAD methods per HTTP spec (browser behavior)
          if (
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) &&
              currentMethod !== "GET" &&
              currentMethod !== "HEAD")
          ) {
            currentMethod = "GET";
            currentBody = undefined;
          }
        }

        // Should not happen — loop always assigns before break — but satisfies TS narrowing
        if (response === undefined) {
          clearTimeout(timer);
          return {
            ok: false,
            error: {
              code: "EXTERNAL",
              message: `Fetch failed for ${url}: no response received`,
              retryable: true,
            },
          };
        }

        // Too many redirects
        if (REDIRECT_STATUS_CODES.has(response.status)) {
          clearTimeout(timer);
          return {
            ok: false,
            error: {
              code: "EXTERNAL",
              message: `Too many redirects (>${MAX_REDIRECTS}) for ${url}`,
              retryable: false,
            },
          };
        }

        clearTimeout(timer);

        const finalUrl = currentUrl;
        const rawBody = await response.text();
        const truncated = rawBody.length > maxBodyChars;
        const body = truncated ? rawBody.slice(0, maxBodyChars) : rawBody;

        const headers: Readonly<Record<string, string>> = Object.fromEntries([
          ...response.headers.entries(),
        ]);

        const result: WebFetchResult = {
          status: response.status,
          statusText: response.statusText,
          headers,
          body,
          truncated,
          finalUrl,
        };

        // Cache successful GET/HEAD responses
        if (fetchCache !== undefined && (method === "GET" || method === "HEAD")) {
          fetchCache.set(cacheKey, result);
        }

        return { ok: true, value: result };
      } catch (e: unknown) {
        clearTimeout(timer);
        const message = e instanceof Error ? e.message : String(e);
        const isTimeout = message.includes("abort") || message.includes("timeout");
        return {
          ok: false,
          error: {
            code: isTimeout ? "TIMEOUT" : "EXTERNAL",
            message: `Fetch failed for ${url}: ${message}`,
            retryable: true,
          },
        };
      }
    },

    search: async (
      query: string,
      options?: WebSearchOptions,
    ): Promise<Result<readonly WebSearchResult[], KoiError>> => {
      // Resolve search backend: searchProvider takes precedence over deprecated searchFn
      if (config.searchProvider === undefined && config.searchFn === undefined) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message:
              "No search backend configured. Provide a searchProvider or searchFn in WebExecutorConfig.",
            retryable: false,
          },
        };
      }

      // Normalize cache key: trim + lowercase query for case-insensitive dedup
      const normalizedQuery = query.trim().toLowerCase();
      const cacheKey = `search:${normalizedQuery}:${options?.maxResults ?? ""}`;
      if (searchCache !== undefined) {
        const cached = searchCache.get(cacheKey);
        if (cached !== undefined) return { ok: true, value: cached };
      }

      // Enforce timeout: wrap search call with AbortController
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), defaultTimeout);

      try {
        // Combine caller's signal with our timeout signal
        if (options?.signal) {
          if (options.signal.aborted) {
            clearTimeout(timer);
            return {
              ok: false,
              error: { code: "TIMEOUT", message: "Search aborted", retryable: false },
            };
          }
          options.signal.addEventListener("abort", () => controller.abort(), { once: true });
        }

        const searchOptions: WebSearchOptions = {
          ...options,
          signal: controller.signal,
        };

        // Call provider directly to preserve `this` context for class-based implementations
        const result =
          config.searchProvider !== undefined
            ? await config.searchProvider.search(query, searchOptions)
            : config.searchFn !== undefined
              ? await config.searchFn(query, searchOptions)
              : undefined;

        // Unreachable — both undefined is handled above. Guard for TypeScript narrowing.
        if (result === undefined) {
          return {
            ok: false,
            error: { code: "VALIDATION", message: "No search backend", retryable: false },
          };
        }

        clearTimeout(timer);

        // Cache successful results
        if (result.ok && searchCache !== undefined) {
          searchCache.set(cacheKey, result.value);
        }
        return result;
      } catch (e: unknown) {
        clearTimeout(timer);
        const message = e instanceof Error ? e.message : String(e);
        const isTimeout = message.includes("abort") || message.includes("timeout");
        return {
          ok: false,
          error: {
            code: isTimeout ? "TIMEOUT" : "EXTERNAL",
            message: `Search failed for "${query}": ${message}`,
            retryable: !isTimeout,
          },
        };
      }
    },
  };
}
