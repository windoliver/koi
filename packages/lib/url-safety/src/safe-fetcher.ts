/**
 * createSafeFetcher — returns a fetch-compatible function that:
 *   1. validates the initial URL via isSafeUrl
 *   2. manually follows redirects (redirect: "manual") so each hop is
 *      re-validated against isSafeUrl before being followed
 *   3. rewrites method/body on redirects following the Fetch spec:
 *        303 → GET, drop body
 *        301/302 with POST → GET, drop body (browser-aligned)
 *        307/308 → preserve method + body
 *   4. preserves Request-object metadata (method, headers, body, signal,
 *      credentials, etc.) when `input` is a Request rather than a string/URL
 *   5. throws on block or when maxRedirects is exceeded
 *
 * Default base is global fetch. Callers pass their own to inject for testing.
 */
import type { UrlSafetyOptions } from "./safe-url.js";
import { isSafeUrl } from "./safe-url.js";

export interface SafeFetcherOptions extends UrlSafetyOptions {
  readonly maxRedirects?: number;
}

const DEFAULT_MAX_REDIRECTS = 5;

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

interface HopState {
  url: string;
  method: string;
  body: FetchInit["body"];
  readonly headers: Headers;
  readonly carry: FetchInit;
}

function initialState(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): HopState {
  const req = input instanceof Request ? input : undefined;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  const headers = new Headers(req?.headers);
  if (init?.headers !== undefined) {
    new Headers(init.headers).forEach((v, k) => {
      headers.set(k, v);
    });
  }

  const carry: FetchInit = {};
  const pick = <K extends keyof FetchInit>(key: K): void => {
    const v = init?.[key] ?? req?.[key as keyof Request];
    if (v !== undefined && v !== null) {
      (carry as Record<string, unknown>)[key] = v;
    }
  };
  pick("signal");
  pick("credentials");
  pick("mode");
  pick("referrer");
  pick("referrerPolicy");
  pick("integrity");
  pick("keepalive");
  pick("cache");

  return {
    url,
    method: init?.method ?? req?.method ?? "GET",
    body: init?.body ?? (req !== undefined ? req.body : undefined),
    headers,
    carry,
  };
}

function toInit(s: HopState): FetchInit {
  const omitBody = s.method === "GET" || s.method === "HEAD";
  return {
    ...s.carry,
    method: s.method,
    headers: s.headers,
    ...(omitBody ? {} : { body: s.body }),
    redirect: "manual",
  };
}

const CROSS_ORIGIN_STRIPPED_HEADERS: readonly string[] = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "proxy-authenticate",
];

function stripCrossOriginHeaders(headers: Headers): void {
  for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) headers.delete(name);
}

function isStreamBody(body: unknown): body is ReadableStream {
  return body instanceof ReadableStream;
}

function rewriteForRedirect(s: HopState, status: number, newUrl: string): void {
  const crossOrigin = new URL(s.url).origin !== new URL(newUrl).origin;
  s.url = newUrl;

  // 303: always GET, drop body (Fetch spec).
  // 301/302 + POST: browser-aligned — most UAs downgrade to GET.
  // 307/308: preserve method + body verbatim.
  const downgrade =
    status === 303 || ((status === 301 || status === 302) && s.method.toUpperCase() === "POST");
  if (downgrade) {
    s.method = "GET";
    s.body = undefined;
    s.headers.delete("content-length");
    s.headers.delete("content-type");
    s.headers.delete("content-encoding");
    s.headers.delete("content-language");
    s.headers.delete("content-location");
  }

  // Non-replayable body on method-preserving redirect: the first fetch already
  // consumed the stream, so resending is either a truncated/empty upload or a
  // runtime error — fail closed rather than silently send a broken request.
  if (!downgrade && isStreamBody(s.body)) {
    throw new Error(
      `url-safety: cannot follow ${status} redirect with a ReadableStream body (non-replayable); buffer the body before calling safeFetch`,
    );
  }

  // Strip credentials on cross-origin redirects — the original caller
  // authenticated to the first origin, not the redirect target.
  if (crossOrigin) stripCrossOriginHeaders(s.headers);
}

export function createSafeFetcher(
  base: typeof fetch = fetch,
  options?: SafeFetcherOptions,
): typeof fetch {
  const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const safeFetchImpl = async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const state = initialState(input, init);

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const check = await isSafeUrl(state.url, options);
      if (!check.ok) {
        throw new Error(`url-safety: ${check.reason}`);
      }

      const response = await base(state.url, toInit(state));

      if (response.status < 300 || response.status >= 400) {
        return response;
      }

      const location = response.headers.get("location");
      if (location === null) return response;

      const nextUrl = new URL(location, state.url).href;
      rewriteForRedirect(state, response.status, nextUrl);
    }

    throw new Error(`url-safety: exceeded ${maxRedirects} redirects`);
  };

  return safeFetchImpl as typeof fetch;
}
