/**
 * createSafeFetcher — returns a fetch-compatible function that:
 *   1. validates the initial URL via isSafeUrl
 *   2. manually follows redirects (redirect: "manual") so each hop is
 *      re-validated against isSafeUrl before being followed
 *   3. throws (rejects) with a descriptive Error if any URL fails the check
 *
 * Default base is global fetch. Callers pass their own to inject for testing.
 */
import type { UrlSafetyOptions } from "./safe-url.js";
import { isSafeUrl } from "./safe-url.js";

export interface SafeFetcherOptions extends UrlSafetyOptions {
  readonly maxRedirects?: number;
}

const DEFAULT_MAX_REDIRECTS = 5;

export function createSafeFetcher(
  base: typeof fetch = fetch,
  options?: SafeFetcherOptions,
): typeof fetch {
  const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const safeFetchImpl = async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    // let is required: currentUrl is mutated on each redirect hop
    let currentUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const check = await isSafeUrl(currentUrl, options);
      if (!check.ok) {
        throw new Error(`url-safety: ${check.reason}`);
      }

      const response = await base(currentUrl, { ...init, redirect: "manual" });

      if (response.status < 300 || response.status >= 400) {
        return response;
      }

      const location = response.headers.get("location");
      if (location === null) return response;

      currentUrl = new URL(location, currentUrl).href;
    }

    throw new Error(`url-safety: exceeded ${maxRedirects} redirects`);
  };

  return safeFetchImpl as typeof fetch;
}
