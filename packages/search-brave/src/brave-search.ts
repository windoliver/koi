/**
 * Brave Search API adapter — returns structured search results.
 *
 * Implements the SearchProvider contract from @koi/search-provider.
 * Depends on @koi/core (L0) and @koi/search-provider (L0u) — no L2 peer imports.
 *
 * Brave Search API docs: https://brave.com/search/api/
 */

import type { KoiError, Result } from "@koi/core";
import type { SearchProvider, WebSearchOptions, WebSearchResult } from "@koi/search-provider";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BraveSearchConfig {
  /** Brave Search API key. */
  readonly apiKey: string;
  /** Custom fetch function (default: globalThis.fetch). */
  readonly fetchFn?: typeof globalThis.fetch | undefined;
  /** API base URL (default: https://api.search.brave.com/res/v1). */
  readonly baseUrl?: string | undefined;
  /** Timeout in ms (default: 10_000). */
  readonly timeoutMs?: number | undefined;
  /** Country code for localized results (e.g., "US", "GB"). */
  readonly country?: string | undefined;
  /** Search freshness: "pd" (past day), "pw" (past week), "pm" (past month). */
  readonly freshness?: string | undefined;
}

/**
 * @deprecated Use `WebSearchResult` from `@koi/search-provider` instead.
 * Kept for backward compatibility.
 */
export type BraveSearchResult = WebSearchResult;

/**
 * @deprecated Use `WebSearchOptions` from `@koi/search-provider` instead.
 * Kept for backward compatibility.
 */
export type BraveSearchOptions = WebSearchOptions;

/**
 * @deprecated Use `SearchProvider` from `@koi/search-provider` instead.
 * Kept for backward compatibility.
 */
export type BraveSearchFn = (
  query: string,
  options?: WebSearchOptions,
) => Promise<Result<readonly WebSearchResult[], KoiError>>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_BRAVE_BASE_URL = "https://api.search.brave.com/res/v1";
export const DEFAULT_BRAVE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 20;

// ---------------------------------------------------------------------------
// API response types (minimal subset)
// ---------------------------------------------------------------------------

interface BraveWebResult {
  readonly title?: string;
  readonly url?: string;
  readonly description?: string;
}

interface BraveApiResponse {
  readonly web?: {
    readonly results?: readonly BraveWebResult[];
  };
}

// ---------------------------------------------------------------------------
// Retry-After parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Retry-After header value into milliseconds.
 * Returns undefined if the value is not a valid non-negative integer.
 */
function parseRetryAfter(header: string): number | undefined {
  const seconds = Number.parseInt(header, 10);
  if (Number.isNaN(seconds) || seconds < 0) {
    return undefined;
  }
  return seconds * 1000;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Brave Search provider implementing the SearchProvider contract.
 *
 * Usage:
 * ```ts
 * import { createBraveSearch } from "@koi/search-brave";
 *
 * const provider = createBraveSearch({ apiKey: process.env.BRAVE_API_KEY! });
 * const result = await provider.search("koi agent engine");
 * ```
 */
export function createBraveSearch(config: BraveSearchConfig): SearchProvider {
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  const baseUrl = config.baseUrl ?? DEFAULT_BRAVE_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_BRAVE_TIMEOUT_MS;

  return {
    name: "brave",
    search: async (
      query: string,
      options?: WebSearchOptions,
    ): Promise<Result<readonly WebSearchResult[], KoiError>> => {
      const maxResults = Math.min(
        Math.max(1, options?.maxResults ?? DEFAULT_MAX_RESULTS),
        MAX_RESULTS_CAP,
      );

      const params = new URLSearchParams({
        q: query,
        count: String(maxResults),
      });

      if (config.country !== undefined) {
        params.set("country", config.country);
      }
      if (config.freshness !== undefined) {
        params.set("freshness", config.freshness);
      }

      const url = `${baseUrl}/web/search?${params.toString()}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
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

        const response = await fetchFn(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": config.apiKey,
          },
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfterMs =
            retryAfterHeader !== null ? parseRetryAfter(retryAfterHeader) : undefined;
          return {
            ok: false,
            error: {
              code: "RATE_LIMIT",
              message: "Brave Search API rate limit exceeded",
              retryable: true,
              context: { retryAfterMs },
            },
          };
        }

        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            error: {
              code: "PERMISSION",
              message: `Brave Search API auth failed (${response.status})`,
              retryable: false,
            },
          };
        }

        if (!response.ok) {
          return {
            ok: false,
            error: {
              code: "EXTERNAL",
              message: `Brave Search API error: ${response.status} ${response.statusText}`,
              retryable: response.status >= 500,
            },
          };
        }

        const data = (await response.json()) as BraveApiResponse;
        const results: readonly WebSearchResult[] = (data.web?.results ?? [])
          .slice(0, maxResults)
          .map((r) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            snippet: r.description ?? "",
          }));

        return { ok: true, value: results };
      } catch (e: unknown) {
        clearTimeout(timer);
        const message = e instanceof Error ? e.message : String(e);
        const isTimeout = message.includes("abort") || message.includes("timeout");
        return {
          ok: false,
          error: {
            code: isTimeout ? "TIMEOUT" : "EXTERNAL",
            message: `Brave Search failed: ${message}`,
            retryable: true,
          },
        };
      }
    },
  };
}
