/**
 * WebExecutor — injectable backend for web fetch and search operations.
 *
 * Abstracts HTTP fetching and web search so both can be mocked in tests
 * and swapped for different backends (Brave, Google, SerpAPI, etc.).
 */

import type { KoiError, Result } from "@koi/core";
import type { DnsResolver } from "@koi/url-safety";
import { createSafeFetcher } from "@koi/url-safety";
import {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_MAX_CACHE_ENTRIES,
  DEFAULT_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_TIMEOUT_MS,
} from "./constants.js";
import { createLruCache } from "./lru-cache.js";

export type DnsResolverFn = DnsResolver;

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
  /** True when this result was served from the in-memory LRU cache. */
  readonly cached: boolean;
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
  /** Name of the search provider backend (e.g., "brave", "tavily") for provenance tracking. */
  readonly providerName?: string | undefined;
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
   * Allow HTTPS URLs (**required** — no default).
   *
   * HTTPS URLs cannot be IP-pinned because Bun's `fetch` does not expose TLS
   * SNI control. After `resolveAndValidateUrl()` confirms a public IP, the
   * actual TLS connect resolves DNS again, creating a TOCTOU window where an
   * attacker with DNS control could rebind to a private IP. HTTP requests are
   * immune because the resolved IP is substituted directly into the URL.
   *
   * - `true`:  Accept the residual SSRF risk for HTTPS. Appropriate when
   *            network-level egress controls block RFC 1918 outbound, or
   *            when the deployment context tolerates the narrow TOCTOU window.
   * - `false`: Reject all HTTPS URLs. Only HTTP (with IP pinning) is allowed.
   */
  readonly allowHttps: boolean;
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
export function createWebExecutor(config: WebExecutorConfig): WebExecutor {
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  const dnsResolver = config.dnsResolver;
  const maxBodyChars = config.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const defaultTimeout = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxCacheEntries = config.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const { allowHttps } = config;

  const fetchCache =
    cacheTtlMs > 0 ? createLruCache<WebFetchResult>(maxCacheEntries, cacheTtlMs) : undefined;
  const searchCache =
    cacheTtlMs > 0
      ? createLruCache<readonly WebSearchResult[]>(maxCacheEntries, cacheTtlMs)
      : undefined;

  // Wrap the resolver so .internal / .local suffix checks apply on every
  // hop — isSafeUrl runs the resolver for each redirect URL, and a throw
  // here surfaces as a blocking DNS failure. Without this wrapper the
  // first-hop pre-flight check could be bypassed by a `302 Location:
  // http://service.internal/` redirect from an attacker-controlled site.
  const suffixAwareResolver: DnsResolverFn = async (hostname) => {
    if (hostnameHasBlockedSuffix(hostname)) {
      throw new Error(`reserved internal domain: ${hostname}`);
    }
    return (dnsResolver ?? defaultDnsResolver)(hostname);
  };

  const safeFetchOptions = {
    dnsResolver: suffixAwareResolver,
    maxRedirects: MAX_REDIRECTS,
    strictAuthoritativeDns: false,
  } as const;

  return {
    providerName: config.searchProvider?.name,
    fetch: async (
      url: string,
      options?: WebFetchOptions,
    ): Promise<Result<WebFetchResult, KoiError>> => {
      // Block HTTPS when strict SSRF mode is opted into.
      // Case-insensitive check: URL schemes are case-insensitive per RFC 3986.
      if (!allowHttps && url.slice(0, 8).toLowerCase() === "https://") {
        return permissionError(
          "HTTPS URLs are blocked (allowHttps: false). HTTPS cannot be IP-pinned, " +
            "creating a DNS rebinding TOCTOU window. Use allowHttps: true to accept " +
            "this residual risk, or add network-level egress controls.",
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
        if (cached !== undefined) return { ok: true, value: { ...cached, cached: true } };
      }

      // Tool-scoped domain-suffix blocklist (pre-DNS). `.internal` / `.local`
      // are reserved for internal/name-service use per RFC6762 / RFC2606 —
      // blocking by suffix stops a malicious DNS record that points an
      // internal hostname at a public IP from passing the safe-fetch gate.
      if (hasBlockedSuffix(url)) {
        return permissionError(`Access to reserved internal domain blocked: ${url}`);
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

        // Wrap fetchFn per-call so we can observe the final URL the safe
        // fetcher actually connects to (post-redirects, post-pin). Without
        // this, createSafeFetcher's internal loop is opaque to the executor.
        // Track the LOGICAL URL of the final hop — the one the caller /
        // redirect chain intended, before createSafeFetcher rewrites it to
        // a validated IP for HTTP pinning. When the wrapper injects a Host
        // header (its synthetic marker), reconstruct the authority from
        // that value so finalUrl retains the original hostname contract.
        let lastRequestedUrl = url;
        const trackingFetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
          const wireUrl =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const hostHdr = new Headers(init?.headers).get("host");
          if (hostHdr !== null) {
            try {
              const logical = new URL(wireUrl);
              logical.host = hostHdr;
              lastRequestedUrl = logical.href;
            } catch {
              lastRequestedUrl = wireUrl;
            }
          } else {
            lastRequestedUrl = wireUrl;
          }
          return (fetchFn as typeof fetch)(input, init);
        }) as unknown as typeof fetch;
        const safeFetch = createSafeFetcher(trackingFetchFn, safeFetchOptions);

        const response = await safeFetch(url, {
          method,
          headers: options?.headers,
          body: options?.body,
          signal: controller.signal,
        });

        clearTimeout(timer);

        const rawBody = await response.text();
        const truncated = rawBody.length > maxBodyChars;
        const body = truncated ? rawBody.slice(0, maxBodyChars) : rawBody;

        const headers: Readonly<Record<string, string>> = Object.fromEntries([
          ...response.headers.entries(),
        ]);

        const fetchResult: WebFetchResult = {
          status: response.status,
          statusText: response.statusText,
          headers,
          body,
          truncated,
          // lastRequestedUrl = URL of the final fetch hop, captured via the
          // tracking fetchFn wrapper. Real Response.url would also carry this
          // but mock fetches in tests don't bind URLs, so tracking the
          // outbound call is more reliable across runtimes.
          finalUrl: lastRequestedUrl,
          cached: false,
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
        // Translate @koi/url-safety rejections into PERMISSION errors so
        // the tool surfaces them to the model the same way the old policy
        // did. Network/timeout failures still flow through catchFetchError.
        if (e instanceof Error && e.message.startsWith("url-safety:")) {
          return permissionError(e.message);
        }
        return catchFetchError(url, method, e);
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
// Helpers
// ---------------------------------------------------------------------------

function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

const BLOCKED_SUFFIXES: readonly string[] = [".internal", ".local"];

function hostnameHasBlockedSuffix(host: string): boolean {
  const lower = host.toLowerCase();
  return BLOCKED_SUFFIXES.some((suffix) => lower === suffix.slice(1) || lower.endsWith(suffix));
}

function hasBlockedSuffix(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return hostnameHasBlockedSuffix(parsed.hostname);
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

/** Safe (idempotent) HTTP methods that can be retried without side effects. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

function catchFetchError<T>(url: string, method: string, e: unknown): Result<T, KoiError> {
  const message = e instanceof Error ? e.message : String(e);
  const isTimeout = message.includes("abort") || message.includes("timeout");
  // Only retry safe/idempotent methods — retrying POST/PUT/DELETE after a
  // timeout risks duplicating mutations the server already committed.
  const retryable = !isTimeout && SAFE_METHODS.has(method);
  return {
    ok: false,
    error: {
      code: isTimeout ? "TIMEOUT" : "EXTERNAL",
      message: `Fetch failed for ${url}: ${message}`,
      retryable,
    },
  };
}
