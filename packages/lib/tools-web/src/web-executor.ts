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
   * Scope: this flag controls cache behavior only. It does NOT rewrite
   * HTTP error statuses into transport-level failures — a 500, 429, or
   * 404 response still comes back as `{ ok: true, value: {...} }` so
   * callers can inspect the status/body and decide what to do. What
   * `noCache` guarantees is about the LRU, not the return type:
   *
   * - The pre-existing entry for the URL is evicted up front (so
   *   concurrent default readers during the refresh RTT miss cache
   *   and hit origin themselves instead of being handed the known-to-
   *   be-revalidating stale value).
   * - A cacheable 200 response within origin's freshness budget writes
   *   through, so later default callers see the fresh content.
   * - A non-cacheable response (4xx/5xx, 206, `Cache-Control:
   *   no-store|no-cache|private|must-revalidate`, past `Expires`, any
   *   `Vary`) or a transport failure leaves the key empty. The very
   *   next default fetch hits origin rather than replaying anything
   *   from before `noCache` was invoked.
   *
   * Callers who want stale-on-error graceful degradation simply don't
   * set `noCache`. Transport failures (network error, timeout, SSRF
   * reject) still surface as `{ ok: false, error }` exactly as they
   * would without `noCache`.
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
  /** Response cache TTL (ms) for `fetch()` GET/HEAD. Set to 0 to disable (default: 0). */
  readonly cacheTtlMs?: number | undefined;
  /**
   * Separate cache TTL (ms) for `search()` results. Defaults to 0 (disabled)
   * independent of `cacheTtlMs`: search staleness has different operator
   * semantics from response caching (fresh results matter more during
   * incidents or on fast-moving topics) and deserves its own knob so hosts
   * can enable one without silently enabling the other.
   */
  readonly searchCacheTtlMs?: number | undefined;
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
  const searchCacheTtlMs = config.searchCacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxCacheEntries = config.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const { allowHttps } = config;

  const fetchCache =
    cacheTtlMs > 0 ? createLruCache<WebFetchResult>(maxCacheEntries, cacheTtlMs) : undefined;
  const searchCache =
    searchCacheTtlMs > 0
      ? createLruCache<readonly WebSearchResult[]>(maxCacheEntries, searchCacheTtlMs)
      : undefined;
  // Two coordinated structures protect the cache from concurrency races.
  //
  // `keyGenerations`: per-key monotonic counter bumped every time `noCache`
  // starts a refresh. In-flight requests capture the generation at start;
  // write-back is refused if the current generation has moved since then.
  // This invalidates any default writer that started before a noCache
  // arrival so the refresh cannot be silently rolled back.
  //
  // `activeRefreshes`: per-key count of currently in-flight `noCache`
  // refreshes. Default writers check it at write time and skip when
  // non-zero, so concurrent default readers during a refresh fetch live
  // (they still return useful data to their caller) but don't pollute
  // the cache with a representation that might be older than the refresh.
  // The noCache caller is the authoritative writer for its refresh cycle.
  const keyGenerations = new Map<string, number>();
  const activeRefreshes = new Map<string, number>();

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
      // GET and HEAD describe the same resource state for caching: a
      // HEAD response's headers are the same as GET minus the body,
      // so a forced refresh of one must invalidate and fence the
      // other. Callers that `HEAD` to re-validate freshness and then
      // `GET` to read content would otherwise read a stale body.
      const peerMethod = method === "GET" ? "HEAD" : method === "HEAD" ? "GET" : undefined;
      const peerKey = peerMethod !== undefined ? `${peerMethod}:${normalizedUrl}` : undefined;
      const invalidationKeys =
        peerKey !== undefined ? ([cacheKey, peerKey] as const) : ([cacheKey] as const);
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

      // `noCache` bumps the per-key generation *before* any read or
      // eviction and registers itself as an active refresh. The bump
      // invalidates any default writer that started before us (their
      // captured generation is now stale). The activeRefreshes entry
      // blocks concurrent default readers from writing while we're
      // still in flight — the noCache caller is the authoritative
      // writer for this refresh cycle. Both the requested method and
      // its GET/HEAD peer are invalidated+fenced together.
      const actsAsRefresh =
        noCache && fetchCache !== undefined && (method === "GET" || method === "HEAD");
      if (actsAsRefresh && fetchCache !== undefined) {
        for (const k of invalidationKeys) {
          keyGenerations.set(k, (keyGenerations.get(k) ?? 0) + 1);
          activeRefreshes.set(k, (activeRefreshes.get(k) ?? 0) + 1);
          fetchCache.delete(k);
        }
      } else if (keyCacheable && fetchCache !== undefined) {
        const cached = fetchCache.get(cacheKey);
        if (cached !== undefined) return { ok: true, value: { ...cached, cached: true } };
      }

      // Capture the generation AFTER any noCache bump. A default request
      // started before us against an older generation will carry that
      // older number to its write site and be denied. A default or
      // noCache started after this point will capture the same (or a
      // higher) generation; only the one whose capture still matches at
      // write time wins — combined with the "first writer at each
      // generation claims the slot" check below, this prevents arrival-
      // order backwards-rollback in every race we can model without
      // ETag/Last-Modified.
      const capturedGeneration = keyGenerations.get(cacheKey) ?? 0;

      const releaseRefreshSlot = (): void => {
        if (!actsAsRefresh) return;
        for (const k of invalidationKeys) {
          const remaining = (activeRefreshes.get(k) ?? 0) - 1;
          if (remaining <= 0) activeRefreshes.delete(k);
          else activeRefreshes.set(k, remaining);
        }
      };

      // Prune the generation counter once this request has released its
      // refresh slot (if any) and nothing else needs it for this key.
      // Without this, a long-lived process using `noCache` across many
      // unique URLs would accumulate unbounded entries in `keyGenerations`
      // even though the actual response LRU stays capped at
      // `maxCacheEntries`. Safe to drop when no refresh is in flight
      // AND the key has no live cache entry — later writers that arrive
      // start fresh from generation 0.
      const pruneGenerationIfIdle = (): void => {
        for (const k of invalidationKeys) {
          if (activeRefreshes.has(k)) continue;
          if (fetchCache !== undefined && fetchCache.getEntry(k) !== undefined) continue;
          keyGenerations.delete(k);
        }
      };

      const timeout = Math.min(options?.timeoutMs ?? defaultTimeout, MAX_TIMEOUT_MS);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        if (options?.signal?.aborted) {
          clearTimeout(timer);
          return abortedError();
        }
        if (options?.signal) {
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
          // Write-fence — three independent conditions must all hold:
          //   (1) Generation match: a newer noCache may have bumped
          //       this key since we started, in which case our response
          //       is stale-by-design and must not repopulate.
          //   (2) No other noCache refresh is currently in flight for
          //       this key (unless we ARE the refresh): default readers
          //       shouldn't pollute the cache while an authoritative
          //       refresh is still running.
          //   (3) Empty slot: at a given generation, only the first
          //       writer populates the key. Later arrivals skip, so
          //       arrival order cannot pin either the stale-fast or
          //       the fresh-slow response under same-gen concurrency.
          const stillOurGeneration = (keyGenerations.get(cacheKey) ?? 0) === capturedGeneration;
          const blockedByPeerRefresh = !actsAsRefresh && (activeRefreshes.get(cacheKey) ?? 0) > 0;
          if (stillOurGeneration && !blockedByPeerRefresh) {
            // Cap to origin's declared freshness budget so a response
            // that says `max-age=5` never lingers for the full cache-
            // wide TTL.
            const originTtlMs = extractOriginFreshnessMs(fetchResult);
            const entryTtlMs =
              originTtlMs !== undefined ? Math.min(cacheTtlMs, originTtlMs) : cacheTtlMs;
            if (entryTtlMs > 0 && fetchCache.getEntry(cacheKey) === undefined) {
              fetchCache.set(cacheKey, fetchResult, entryTtlMs);
            }
          }
        }

        return { ok: true, value: fetchResult };
      } catch (e: unknown) {
        clearTimeout(timer);
        return catchFetchError(url, method, e);
      } finally {
        releaseRefreshSlot();
        pruneGenerationIfIdle();
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
