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
  /**
   * Force-revalidation mode. Semantics: "do not serve stale, period."
   *
   * Evicts any pre-existing entry for the URL up front (so concurrent
   * default readers during the refresh RTT miss cache and hit origin
   * themselves) and issues a live request:
   *
   * - Cacheable success (200 within origin's declared freshness budget):
   *   the new response is written to the cache. Later default callers
   *   see the fresh content without needing `noCache` themselves.
   * - Non-cacheable response (e.g. 500, 206, or a cache-forbidding
   *   header) or any transport failure (network error, abort, SSRF
   *   rejection): the key is left empty. The call returns the failure
   *   to the caller; no stale fallback is served here or on the very
   *   next default fetch. If stale-on-error graceful degradation is
   *   needed, callers should simply not set `noCache`.
   *
   * Use when verifying a just-changed page or refreshing after a known
   * update — cases where stale data is worse than no data.
   */
  readonly noCache?: boolean | undefined;
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
      const hasRequestBody = options?.body !== undefined && options.body !== "";
      const noCache = options?.noCache === true;
      const normalizedUrl = normalizeUrl(url);
      const cacheKey = `${method}:${normalizedUrl}`;
      // Key is eligible for caching if it's a GET/HEAD without custom headers
      // (headers like Accept, Range, or auth tokens change representation) and
      // without a request body (unusual for GET/HEAD but permitted by the
      // executor contract — two GETs to the same URL with different bodies
      // are logically distinct and must not alias to the same cache entry).
      // `noCache` only flips the *read* side — reconciliation still runs
      // once we know what the live response looks like (see below).
      const keyCacheable =
        fetchCache !== undefined &&
        !hasCustomHeaders &&
        !hasRequestBody &&
        (method === "GET" || method === "HEAD");

      // `noCache` means "do not serve stale, period". We evict any prior
      // entry up front so concurrent default readers during the refresh
      // RTT miss cache and hit origin themselves, and — unlike earlier
      // rounds of this patch — we never restore the snapshot on transport
      // errors or policy rejections. That's the contract promised to the
      // tool caller (`web_fetch` doc: "failed response leaves the key
      // empty — no stale fallback") and the right default for interactive
      // CLI verification. Callers who want stale-on-error graceful
      // degradation can simply not set `noCache`.
      if (noCache && keyCacheable && fetchCache !== undefined) {
        fetchCache.delete(cacheKey);
      } else if (keyCacheable && fetchCache !== undefined) {
        const cached = fetchCache.get(cacheKey);
        if (cached !== undefined) return { ok: true, value: { ...cached, cached: true } };
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

        // SSRF first pass: fast string-based pattern match before DNS
        if (isBlockedUrl(url)) {
          clearTimeout(timer);
          return permissionError(`Access to private/internal URL blocked: ${url}`);
        }

        // SSRF second pass: resolve and validate the IP to mitigate DNS rebinding
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
          cached: false,
        };

        // Cache only demonstrably-replayable success responses. Transient
        // failures (4xx/5xx), partial content (206), and any response marked
        // non-cacheable by origin would otherwise become sticky for the TTL
        // and mask recovery from every subsequent caller.
        //
        // Reconciliation for `noCache`: if we got a cacheable response we
        // write it through (overwriting any prior entry). If origin returned
        // something non-cacheable the pre-existing entry is now known-stale,
        // so we do NOT restore `savedEntry` — it stays evicted. A transport
        // error/abort never reaches this block (handled by the restore-on-
        // failure paths above), so the prior entry survives as fallback.
        if (keyCacheable && fetchCache !== undefined && isCacheableResponse(fetchResult)) {
          // Cap to origin's declared freshness budget so a response that
          // says `max-age=5` never lingers for the full cache-wide TTL.
          const originTtlMs = extractOriginFreshnessMs(fetchResult);
          const entryTtlMs =
            originTtlMs !== undefined ? Math.min(cacheTtlMs, originTtlMs) : cacheTtlMs;
          if (entryTtlMs > 0) fetchCache.set(cacheKey, fetchResult, entryTtlMs);
        }

        return { ok: true, value: fetchResult };
      } catch (e: unknown) {
        clearTimeout(timer);
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

/**
 * Remaining freshness (ms) per RFC 7234, simplified for an end-cache:
 *
 *   freshness_lifetime = max-age ?? (Expires - Date)
 *   current_age        = max(Age, now - Date)
 *   remaining          = freshness_lifetime - current_age
 *
 * This executor's LRU is a *private* per-process cache, so `s-maxage` (a
 * directive for shared caches only) is intentionally ignored — otherwise
 * a response like `max-age=60, s-maxage=3600` would be replayed for an
 * hour even though origin permits end clients only 60 seconds.
 *
 * Returns `undefined` when origin declared no concrete lifetime (caller
 * falls back to the cache-wide TTL) and `0` when the response was already
 * stale at receive time (caller skips the cache write).
 */
function extractOriginFreshnessMs(result: WebFetchResult): number | undefined {
  const cc = result.headers["cache-control"]?.toLowerCase();
  const now = Date.now();
  const dateMs = parseHttpDateMs(result.headers.date);
  const apparentAgeMs = dateMs !== undefined ? Math.max(0, now - dateMs) : 0;
  const ageHeaderMs = (matchNonNegInteger(result.headers.age) ?? 0) * 1000;
  const currentAgeMs = Math.max(apparentAgeMs, ageHeaderMs);

  let lifetimeMs: number | undefined;
  if (cc !== undefined) {
    const maxAge = matchCacheDirectiveSeconds(cc, "max-age");
    if (maxAge !== undefined) lifetimeMs = maxAge * 1000;
  }
  if (lifetimeMs === undefined) {
    const expiresMs = parseHttpDateMs(result.headers.expires);
    if (expiresMs !== undefined) {
      // Prefer the origin's own clock (`Date` header) to compute how much
      // of the Expires window was actually available. Fall back to local
      // clock when `Date` is missing.
      const basisMs = dateMs ?? now;
      const window = expiresMs - basisMs;
      if (window > 0) lifetimeMs = window;
    }
  }
  if (lifetimeMs === undefined) return undefined;

  const remaining = lifetimeMs - currentAgeMs;
  return remaining > 0 ? remaining : 0;
}

function parseHttpDateMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function matchNonNegInteger(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function matchCacheDirectiveSeconds(cc: string, name: string): number | undefined {
  const regex = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*(\\d+)`);
  const match = regex.exec(cc);
  if (match === null) return undefined;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * True when a fetched response is safe to store in the LRU and replay.
 *
 * Restricted to HTTP 200 (full-body success) — 206 partials would leak
 * range-specific bytes across callers, and 4xx/5xx responses would make
 * transient failures sticky for the TTL. On top of status, we honor the
 * full set of origin freshness/revalidation signals so a page that asks
 * for revalidation on every read is never served from our in-memory LRU:
 *
 * - `Cache-Control: no-store | no-cache | private` — explicit opt-out
 * - `Cache-Control: must-revalidate | proxy-revalidate` — origin requires
 *   validation every read, not replay
 * - `Cache-Control: max-age=0 | s-maxage=0` — freshness budget is zero
 * - `Pragma: no-cache` — HTTP/1.0 revalidation directive
 * - `Expires` in the past — response is already stale at receive time
 */
function isCacheableResponse(result: WebFetchResult): boolean {
  if (result.status !== 200) return false;

  const cc = result.headers["cache-control"]?.toLowerCase();
  if (cc !== undefined) {
    if (cc.includes("no-store") || cc.includes("no-cache") || cc.includes("private")) return false;
    if (cc.includes("must-revalidate") || cc.includes("proxy-revalidate")) return false;
    if (/(?:^|[,\s])(?:s-)?max-age\s*=\s*0(?:\D|$)/.test(cc)) return false;
  }

  const pragma = result.headers.pragma?.toLowerCase();
  if (pragma?.includes("no-cache")) return false;

  const expires = result.headers.expires;
  if (expires !== undefined) {
    const t = Date.parse(expires);
    if (!Number.isNaN(t) && t <= Date.now()) return false;
  }

  // `Vary` names request-header dimensions that would have produced a
  // different representation. Our cache key is just `METHOD:URL`, so we
  // cannot honor `Vary` correctly without widening the key. Skip the
  // cache entirely when `Vary` is present — the explicit `*` case is
  // mandatory ("nothing is reusable"), and every other form is unsafe
  // under the current key model.
  const vary = result.headers.vary?.trim();
  if (vary !== undefined && vary !== "") return false;

  return true;
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
