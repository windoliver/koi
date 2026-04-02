/**
 * WebExecutor — injectable backend for web fetch and search operations.
 *
 * Abstracts HTTP fetching and web search so both can be mocked in tests
 * and swapped for different backends (Brave, Google, SerpAPI, etc.).
 */

import type { KoiError, Result } from "@koi/core";
import {
  CROSS_ORIGIN_SENSITIVE_HEADERS,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_MAX_CACHE_ENTRIES,
  DEFAULT_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_TIMEOUT_MS,
  REDIRECT_STATUS_CODES,
} from "./constants.js";
import { createLruCache } from "./lru-cache.js";
import type { DnsResolverFn } from "./url-policy.js";
import { isBlockedUrl, pinResolvedIp, resolveAndValidateUrl } from "./url-policy.js";

// ---------------------------------------------------------------------------
// Search provider types (defined locally to avoid L2→L2 dep)
// ---------------------------------------------------------------------------

/** A single web search result, normalized across all providers. */
export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** Options passed to a search provider's search() method. */
export interface WebSearchOptions {
  readonly maxResults?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * A pluggable web search backend (e.g., Brave, Tavily, SearXNG).
 * Injected at config time — @koi/tools-web never imports a concrete provider.
 */
export interface SearchProvider {
  readonly name: string;
  readonly search: (
    query: string,
    options?: WebSearchOptions,
  ) => Promise<Result<readonly WebSearchResult[], KoiError>>;
}

// ---------------------------------------------------------------------------
// Fetch types
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
  /** Custom DNS resolver for pre-flight SSRF validation. */
  readonly dnsResolver?: DnsResolverFn | undefined;
  /** Pluggable search provider. */
  readonly searchProvider?: SearchProvider | undefined;
  /** Max response body size in characters (default: 50_000). */
  readonly maxBodyChars?: number | undefined;
  /** Default timeout in ms (default: 15_000). */
  readonly defaultTimeoutMs?: number | undefined;
  /** Cache TTL in ms. Set to 0 to disable caching (default: 0 — disabled). */
  readonly cacheTtlMs?: number | undefined;
  /** Max cache entries (default: 100). */
  readonly maxCacheEntries?: number | undefined;
  /**
   * Whether to allow HTTPS URLs (default: false).
   *
   * HTTPS URLs cannot be IP-pinned because Bun's `fetch` does not support
   * custom TLS SNI (serverName). This creates a TOCTOU window: a DNS record
   * may resolve to a public IP during validation then rebind to a private IP
   * before the actual TLS connection. Set to `true` only when network-level
   * egress controls (e.g., firewall rules blocking RFC 1918) are in place.
   */
  readonly allowHttps?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a WebExecutor backed by the platform `fetch` API.
 *
 * Side-effect: makes HTTP requests when `fetch()` is called.
 * Search requires a `searchProvider` in config — returns VALIDATION error without one.
 */
export function createWebExecutor(config: WebExecutorConfig = {}): WebExecutor {
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  const dnsResolver = config.dnsResolver;
  const maxBodyChars = config.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const defaultTimeout = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxCacheEntries = config.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const allowHttps = config.allowHttps ?? false;

  const fetchCache =
    cacheTtlMs > 0 ? createLruCache<WebFetchResult>(maxCacheEntries, cacheTtlMs) : undefined;
  const searchCache =
    cacheTtlMs > 0
      ? createLruCache<readonly WebSearchResult[]>(maxCacheEntries, cacheTtlMs)
      : undefined;

  return {
    fetch: async (
      url: string,
      options?: WebFetchOptions,
    ): Promise<Result<WebFetchResult, KoiError>> => {
      // Reject HTTPS when strict SSRF protection is enabled
      if (!allowHttps && url.startsWith("https://")) {
        return permissionError(
          "HTTPS URLs are blocked (allowHttps: false). HTTPS cannot be IP-pinned, " +
            "creating a DNS rebinding TOCTOU window.",
        );
      }

      const method = options?.method ?? "GET";
      const hasCustomHeaders =
        options?.headers !== undefined && Object.keys(options.headers).length > 0;
      const normalizedUrl = normalizeUrl(url);
      const cacheKey = `${method}:${normalizedUrl}`;

      // Check cache (GET/HEAD only, never when custom headers are present —
      // headers like Accept, Range, or auth tokens change representation/semantics)
      if (
        fetchCache !== undefined &&
        !hasCustomHeaders &&
        (method === "GET" || method === "HEAD")
      ) {
        const cached = fetchCache.get(cacheKey);
        if (cached !== undefined) return { ok: true, value: cached };
      }

      const timeout = Math.min(options?.timeoutMs ?? defaultTimeout, MAX_TIMEOUT_MS);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        if (options?.signal) {
          if (options.signal.aborted) {
            clearTimeout(timer);
            return abortedError();
          }
          options.signal.addEventListener("abort", () => controller.abort(), { once: true });
        }

        // DNS rebinding mitigation: resolve and validate the initial URL's IP
        const dnsResult = await resolveAndValidateUrl(url, dnsResolver ?? defaultDnsResolver);
        if (dnsResult.blocked) {
          clearTimeout(timer);
          return permissionError(`DNS validation blocked: ${dnsResult.reason}`);
        }

        // Pin the resolved IP for HTTP to prevent DNS rebinding
        const pinned = pinResolvedIp(url, dnsResult.ip);
        const result = await executeRedirectLoop(
          fetchFn,
          dnsResolver ?? defaultDnsResolver,
          pinned?.url ?? url,
          url,
          method,
          pinned?.hostHeader !== undefined
            ? { ...options?.headers, Host: pinned.hostHeader }
            : options?.headers,
          options?.body,
          controller.signal,
        );

        clearTimeout(timer);

        if (!result.ok) return result;

        const rawBody = await result.value.response.text();
        const truncated = rawBody.length > maxBodyChars;
        const body = truncated ? rawBody.slice(0, maxBodyChars) : rawBody;

        const headers: Readonly<Record<string, string>> = Object.fromEntries([
          ...result.value.response.headers.entries(),
        ]);

        const fetchResult: WebFetchResult = {
          status: result.value.response.status,
          statusText: result.value.response.statusText,
          headers,
          body,
          truncated,
          finalUrl: result.value.finalUrl,
        };

        if (
          fetchCache !== undefined &&
          !hasCustomHeaders &&
          (method === "GET" || method === "HEAD")
        ) {
          fetchCache.set(cacheKey, fetchResult);
        }

        return { ok: true, value: fetchResult };
      } catch (e: unknown) {
        clearTimeout(timer);
        return catchFetchError(url, e);
      }
    },

    search: async (
      query: string,
      options?: WebSearchOptions,
    ): Promise<Result<readonly WebSearchResult[], KoiError>> => {
      if (config.searchProvider === undefined) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "No search backend configured. Provide a searchProvider in WebExecutorConfig.",
            retryable: false,
          },
        };
      }

      const normalizedQuery = query.trim().toLowerCase();
      const cacheKey = `search:${normalizedQuery}:${options?.maxResults ?? ""}`;
      if (searchCache !== undefined) {
        const cached = searchCache.get(cacheKey);
        if (cached !== undefined) return { ok: true, value: cached };
      }

      const searchController = new AbortController();
      const timer = setTimeout(() => searchController.abort(), defaultTimeout);

      try {
        if (options?.signal) {
          if (options.signal.aborted) {
            clearTimeout(timer);
            return abortedError();
          }
          options.signal.addEventListener("abort", () => searchController.abort(), { once: true });
        }

        const searchOptions: WebSearchOptions = {
          ...options,
          signal: searchController.signal,
        };

        const result = await config.searchProvider.search(query, searchOptions);
        clearTimeout(timer);

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

// ---------------------------------------------------------------------------
// Redirect loop (extracted to keep factory under size limit)
// ---------------------------------------------------------------------------

interface RedirectResult {
  readonly response: Response;
  readonly finalUrl: string;
}

async function executeRedirectLoop(
  fetchFn: typeof globalThis.fetch,
  dnsResolver: DnsResolverFn,
  startUrl: string,
  logicalUrl: string,
  startMethod: string,
  startHeaders: Readonly<Record<string, string>> | undefined,
  startBody: string | undefined,
  signal: AbortSignal,
): Promise<Result<RedirectResult, KoiError>> {
  let currentUrl = startUrl;
  let currentLogicalUrl = logicalUrl;
  let currentMethod = startMethod;
  let currentHeaders = startHeaders;
  let currentBody = startBody;
  let response: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await fetchFn(currentUrl, {
      method: currentMethod,
      headers: currentHeaders,
      body: currentBody,
      signal,
      redirect: "manual",
    });

    if (!REDIRECT_STATUS_CODES.has(response.status)) break;

    const location = response.headers.get("location");
    if (location === null || location === "") break;

    const nextUrl = new URL(location, currentLogicalUrl).href;

    if (isBlockedUrl(nextUrl)) {
      return permissionError(`Redirect to private/internal URL blocked: ${nextUrl}`);
    }

    const redirectDns = await resolveAndValidateUrl(nextUrl, dnsResolver);
    if (redirectDns.blocked) {
      return permissionError(`Redirect DNS validation blocked: ${redirectDns.reason}`);
    }

    // Strip sensitive headers on cross-origin redirects
    if (currentHeaders !== undefined) {
      const currentOrigin = new URL(currentLogicalUrl).origin;
      const nextOrigin = new URL(nextUrl).origin;
      if (currentOrigin !== nextOrigin) {
        currentHeaders = Object.fromEntries(
          Object.entries(currentHeaders).filter(
            ([k]) => !CROSS_ORIGIN_SENSITIVE_HEADERS.has(k.toLowerCase()),
          ),
        );
      }
    }

    const redirectPinned = pinResolvedIp(nextUrl, redirectDns.ip);
    currentUrl = redirectPinned?.url ?? nextUrl;
    currentLogicalUrl = nextUrl;
    if (redirectPinned?.hostHeader !== undefined) {
      currentHeaders = { ...currentHeaders, Host: redirectPinned.hostHeader };
    } else if (currentHeaders !== undefined && "Host" in currentHeaders) {
      const { Host: _, ...rest } = currentHeaders;
      currentHeaders = rest;
    }

    // 303 always converts to GET; 301/302 convert for non-GET/HEAD
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

  if (response === undefined) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Fetch failed for ${logicalUrl}: no response received`,
        retryable: true,
      },
    };
  }

  if (REDIRECT_STATUS_CODES.has(response.status)) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Too many redirects (>${MAX_REDIRECTS}) for ${logicalUrl}`,
        retryable: false,
      },
    };
  }

  return { ok: true, value: { response, finalUrl: currentLogicalUrl } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

const defaultDnsResolver: DnsResolverFn = async (hostname: string): Promise<readonly string[]> => {
  const results = await Bun.dns.lookup(hostname, {});
  return results.map((r) => r.address);
};

function permissionError<T>(message: string): Result<T, KoiError> {
  return {
    ok: false,
    error: { code: "PERMISSION", message, retryable: false },
  };
}

function abortedError<T>(): Result<T, KoiError> {
  return {
    ok: false,
    error: { code: "TIMEOUT", message: "Request aborted", retryable: false },
  };
}

function catchFetchError<T>(url: string, e: unknown): Result<T, KoiError> {
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
