/**
 * Scoped fetcher — narrows a `fetch`-compatible function to a URLPattern
 * allowlist. Any request whose URL does not match at least one allowed
 * pattern fails closed with a thrown `Error` (mirroring `@koi/url-safety`'s
 * convention) before the inner fetcher is invoked.
 *
 * Composition with `@koi/url-safety`'s `createSafeFetcher` is intentional:
 *   const safe = createSafeFetcher({ fetch: createScopedFetcher(fetch, {...}) })
 * Each manual redirect hop reaches `createScopedFetcher`, so per-hop URLs
 * are re-validated against the scope (a redirect cannot escape).
 */

type FetchFn = typeof fetch;

export interface ScopedFetcherOptions {
  readonly allow: readonly URLPattern[];
}

function extractUrl(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function createScopedFetcher(inner: FetchFn, opts: ScopedFetcherOptions): FetchFn {
  const allow = opts.allow;

  const scopedFetch = async (
    input: Parameters<FetchFn>[0],
    init?: Parameters<FetchFn>[1],
  ): Promise<Response> => {
    const url = extractUrl(input);
    let matched = false;
    for (const pattern of allow) {
      if (pattern.test(url)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      throw new Error(`governance-scope: URL '${url}' is outside the allowed fetch scope`);
    }
    return inner(input, init);
  };

  return scopedFetch as typeof fetch;
}
