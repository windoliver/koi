/**
 * createSafeFetcher — fetch wrapper that centralises SSRF defence.
 *
 * Behaviour:
 *   1. Validates the initial URL via isSafeUrl.
 *   2. Manually follows redirects (`redirect: "manual"`) so each hop is
 *      re-validated before being followed.
 *   3. Rewrites method/body on redirects following Fetch semantics:
 *        303            → GET, drop body (and Content-* headers)
 *        301/302 + POST → GET, drop body (browser-aligned)
 *        307/308        → preserve method + body
 *   4. Preserves Request-object metadata (method, headers, body, signal,
 *      credentials, referrer, etc.) when `input` is a Request.
 *   5. Buffers stream bodies once up-front into a Uint8Array so that
 *      method-preserving redirects (307/308) can safely replay and so that
 *      Node 22 fetch doesn't require the caller to set `duplex: "half"`.
 *   6. On cross-origin redirects strips `authorization`, `cookie`,
 *      `proxy-authorization`, `proxy-authenticate` — credentials belong
 *      to the origin that authorised the call, not a redirect target.
 *   7. For http:// requests, pins the outbound connection to the IP
 *      returned by isSafeUrl's DNS lookup — rewrites the URL to the IP
 *      and sets a Host header so the TCP socket cannot be rebound between
 *      validation and connect. https:// cannot be safely pinned without
 *      breaking TLS SNI / cert verification, so https retains a short
 *      TOCTOU window (documented in docs/L0u/url-safety.md).
 *   8. Throws on block, on exceeding maxRedirects, or on pin failure.
 *
 * Default base is global fetch. Callers pass their own to inject for testing.
 */
import type { SafeUrlResult, UrlSafetyOptions } from "./safe-url.js";
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

async function bufferBody(body: FetchInit["body"]): Promise<FetchInit["body"]> {
  if (body === null || body === undefined) return body;
  if (body instanceof ReadableStream) {
    const buf = await new Response(body).arrayBuffer();
    return new Uint8Array(buf);
  }
  return body;
}

async function initialState(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<HopState> {
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

  const rawBody = init?.body ?? (req !== undefined ? req.body : undefined);
  const body = await bufferBody(rawBody);

  return {
    url,
    method: init?.method ?? req?.method ?? "GET",
    body,
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

function rewriteForRedirect(s: HopState, status: number, newUrl: string): void {
  const crossOrigin = new URL(s.url).origin !== new URL(newUrl).origin;
  s.url = newUrl;

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

  if (crossOrigin) stripCrossOriginHeaders(s.headers);
}

/**
 * For http:// URLs, rewrite to connect to the validated IP directly —
 * this closes the DNS-rebinding window between isSafeUrl and the TCP
 * connect. Returns the URL to actually pass to fetch and mutates
 * `headers` to carry the original Host.
 *
 * Returns the input URL unchanged for https://, IP-literal hosts, or
 * when isSafeUrl did not produce resolved IPs.
 */
function pinHttpToIp(url: string, check: SafeUrlResult, headers: Headers): string {
  if (!check.ok) return url;
  if (check.resolvedIps.length === 0) return url;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:") return url;
  // IP-literal: hostname already matches resolvedIps[0]; no rewrite needed.
  if (parsed.hostname === check.resolvedIps[0]) return url;
  const ip = check.resolvedIps[0];
  if (ip === undefined) return url;
  headers.set("host", parsed.host);
  parsed.hostname = ip.includes(":") ? `[${ip}]` : ip;
  return parsed.href;
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
    const state = await initialState(input, init);

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const check = await isSafeUrl(state.url, options);
      if (!check.ok) {
        throw new Error(`url-safety: ${check.reason}`);
      }

      const pinnedUrl = pinHttpToIp(state.url, check, state.headers);
      const response = await base(pinnedUrl, toInit(state));

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
