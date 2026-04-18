/**
 * createSafeFetcher — fetch wrapper that centralises SSRF defence.
 *
 * Behaviour:
 *   1. Extracts the initial URL from the input (string | URL | Request).
 *      Validates it via isSafeUrl BEFORE touching the body. A blocked or
 *      malformed URL rejects immediately — no body bytes are read and no
 *      memory is allocated for buffering.
 *   2. If the URL passes, buffers any stream-backed body (ReadableStream,
 *      Request.body) into a bounded Uint8Array so 307/308 redirects can
 *      safely replay and Node 22 fetch doesn't require duplex: "half".
 *      The buffer honours an abort signal passed via init.signal.
 *   3. Manually follows redirects (redirect: "manual"). Each hop URL is
 *      re-validated before the next fetch.
 *   4. Rewrites method/body on redirects per Fetch spec:
 *        303            → GET, drop body + Content-* headers
 *        301/302 + POST → GET, drop body (browser-aligned)
 *        307/308        → preserve method + body
 *   5. Preserves Request metadata (method, headers, body, signal,
 *      credentials, referrer, etc.).
 *   6. On cross-origin redirects strips authorization / cookie /
 *      proxy-authorization / proxy-authenticate.
 *   7. HTTP pinning: after validation, rewrite the outbound URL to each
 *      resolved IP (with a Host header preserving the original hostname)
 *      so the TCP socket cannot be DNS-rebound between check and connect.
 *      When multiple IPs pass validation, they are tried sequentially on
 *      connect failure so multi-A/AAAA failover still works — each attempt
 *      goes to an already-validated address, so rebind is not possible.
 *      HTTPS is never pinned (TLS SNI / cert verification).
 *   8. Throws on block, on exceeding maxRedirects, or on oversized bodies.
 *
 * Default base is global fetch. Callers pass their own to inject for testing.
 */
import type { SafeUrlResult, UrlSafetyOptions } from "./safe-url.js";
import { isSafeUrl } from "./safe-url.js";

export interface SafeFetcherOptions extends UrlSafetyOptions {
  readonly maxRedirects?: number;
  /**
   * Maximum bytes to buffer from a stream-backed request body so that
   * method-preserving redirects (307/308) can replay. Default: 10 MB.
   * Set to 0 to disable buffering — stream bodies will then be rejected
   * up front, matching strict-streaming semantics.
   */
  readonly maxBufferedBodyBytes?: number;
  /**
   * Opt-in acknowledgement that a caller-supplied `dispatcher` / `agent`
   * controls the connection path independently of `isSafeUrl`. Default
   * `false` fails closed on any request that combines this wrapper's
   * SSRF guarantee with a transport that bypasses it. Set to `true`
   * only if the transport itself applies equivalent destination-pinning
   * (e.g., a locked-resolver egress proxy that enforces its own
   * allowlist).
   *
   * Note: `Request` objects store internal dispatcher/agent state on
   * symbols, which the wrapper cannot introspect. For Request inputs,
   * always set `trustCustomTransport: true` (or attach transport via
   * `init` instead of the Request) to make the trust decision explicit.
   */
  readonly trustCustomTransport?: boolean;
  /**
   * Opt-in for a caller-supplied `Host` header. Default `false` rejects
   * any request that sets `Host` explicitly: on HTTPS the wrapper cannot
   * pin to the validated IP, so a mismatched Host lets reverse proxies
   * route the request to a different vhost/tenant than `isSafeUrl`
   * approved. Only set `true` for trusted internal paths where the
   * effective authority is validated elsewhere.
   */
  readonly allowCustomHost?: boolean;
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BUFFERED_BODY_BYTES = 10 * 1024 * 1024;

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

interface HopState {
  url: string;
  method: string;
  body: FetchInit["body"];
  readonly headers: Headers;
  readonly carry: FetchInit;
  // Tracks whether the current `host` header was set by the wrapper's
  // HTTP pinning (synthetic) or came from the caller. Only synthetic
  // values are cleared between hops — a caller-supplied Host for
  // virtual-host routing / request signing / proxy dispatch must survive.
  syntheticHost: boolean;
  // Preserved for hop 0 only so internal Request state (dispatcher on
  // undici symbols, cache, credentials behaviour, etc.) reaches the
  // transport untouched. Cleared after the first hop — redirects always
  // reconstruct from URL.
  originalRequest: Request | undefined;
  // True when state.headers came from the original Request verbatim
  // (no init.headers override). Required to safely passthrough the
  // Request without losing "init.headers replaces Request headers"
  // semantics — if the caller did override, we can't rely on
  // `new Request(req, { headers })` to clear stale headers in all runtimes.
  readonly headersAreFromRequest: boolean;
  // Snapshot of SafeFetcherOptions.trustCustomTransport threaded here so
  // fetchWithPin can decide whether Request passthrough is safe.
  readonly trustCustomTransport: boolean;
}

function extractUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (signal === undefined || signal === null) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException("url-safety: body buffering aborted", "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function asyncIteratorOf(body: unknown): AsyncIterator<unknown> | undefined {
  if (body === null || body === undefined || typeof body !== "object") return undefined;
  const fn = (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  if (typeof fn !== "function") return undefined;
  return (fn as () => AsyncIterator<unknown>).call(body);
}

function chunkToBytes(chunk: unknown): Uint8Array | undefined {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return undefined;
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function bufferBody(
  body: FetchInit["body"],
  maxBytes: number,
  signal: AbortSignal | null | undefined,
): Promise<FetchInit["body"]> {
  if (body === null || body === undefined) return body;
  const isStream = body instanceof ReadableStream;
  const asyncIter = isStream ? undefined : asyncIteratorOf(body);
  if (!isStream && asyncIter === undefined) return body;

  if (maxBytes <= 0) {
    throw new Error(
      "url-safety: stream-backed request bodies are not supported when maxBufferedBodyBytes=0",
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  if (isStream) {
    const reader = body.getReader();
    try {
      while (true) {
        if (signal?.aborted === true) {
          throw new DOMException("url-safety: body buffering aborted", "AbortError");
        }
        const { value, done } = await raceAbort(reader.read(), signal);
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error(
            `url-safety: request body exceeds maxBufferedBodyBytes (${maxBytes}); use a smaller payload or route streaming uploads around this wrapper`,
          );
        }
        chunks.push(value);
      }
    } catch (e: unknown) {
      await reader.cancel().catch(() => undefined);
      throw e;
    }
  } else if (asyncIter !== undefined) {
    try {
      while (true) {
        if (signal?.aborted === true) {
          throw new DOMException("url-safety: body buffering aborted", "AbortError");
        }
        const next = await raceAbort(asyncIter.next(), signal);
        if (next.done === true) break;
        const bytes = chunkToBytes(next.value);
        if (bytes === undefined) {
          throw new TypeError(
            "url-safety: AsyncIterable body yielded an unsupported chunk type (expected Uint8Array, string, ArrayBuffer, or TypedArray)",
          );
        }
        total += bytes.byteLength;
        if (total > maxBytes) {
          throw new Error(
            `url-safety: request body exceeds maxBufferedBodyBytes (${maxBytes}); use a smaller payload or route streaming uploads around this wrapper`,
          );
        }
        chunks.push(bytes);
      }
    } catch (e: unknown) {
      if (typeof asyncIter.return === "function") {
        await asyncIter.return().catch(() => undefined);
      }
      throw e;
    }
  }

  return concatBytes(chunks, total);
}

async function buildState(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  maxBufferedBodyBytes: number,
  bufferStreamBodies: boolean,
  trustCustomTransport: boolean,
): Promise<HopState> {
  const req = input instanceof Request ? input : undefined;
  // Match native fetch semantics: a consumed Request is only invalid if we'd
  // actually reuse req.body. A common middleware pattern is to pass a
  // previously-read Request together with a fresh `init.body` (after
  // logging / signing / transforming the payload) — fetch accepts that, so
  // must we. Only throw when the outgoing body would truly come from the
  // disturbed Request stream.
  if (req !== undefined && req.bodyUsed && init?.body === undefined) {
    throw new TypeError(
      "url-safety: Request body is already consumed (bodyUsed=true) and no init.body was provided; clone or re-create the Request before passing to safeFetch",
    );
  }
  const url = extractUrl(input);

  // Native fetch(Request, init) REPLACES the Request's headers when
  // init.headers is provided (Fetch spec: "set request's header list to a
  // copy of init.headers"). A merge would leak the Request's original
  // Authorization/Cookie/x-api-key back onto the wire even when the caller
  // explicitly tried to scrub them — a real disclosure hazard in a wrapper
  // whose job is to prevent that.
  const headers =
    init?.headers !== undefined ? new Headers(init.headers) : new Headers(req?.headers);

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
  // Duplex must survive when the caller preserves a raw stream body.
  pick("duplex" as keyof FetchInit);
  // Transport-layer options used by callers to force traffic through a
  // proxy, custom CA/mTLS stack, or audited egress path. Stripping these
  // would silently bypass the very egress controls this wrapper exists
  // to harden. Node/undici: `dispatcher`; older Node fetch: `agent`.
  pick("dispatcher" as keyof FetchInit);
  pick("agent" as keyof FetchInit);

  const signal = init?.signal ?? req?.signal;
  const rawBody = init?.body ?? (req !== undefined ? req.body : undefined);

  // Native fetch rejects GET / HEAD with a body as TypeError. Match that
  // contract instead of silently dropping the payload — otherwise a signed
  // or stateful request could be transformed into an empty GET on the wire,
  // hitting different cache/auth paths than intended.
  const effectiveMethod = (init?.method ?? req?.method ?? "GET").toUpperCase();
  if (
    (effectiveMethod === "GET" || effectiveMethod === "HEAD") &&
    rawBody !== undefined &&
    rawBody !== null
  ) {
    throw new TypeError(
      `url-safety: ${effectiveMethod} request cannot have a body (matches native fetch semantics)`,
    );
  }
  // Buffer only when redirect-replay could actually be needed. For
  // redirect: "manual"/"error" (or maxRedirects=0) we'll never follow a
  // redirect, so streaming bodies pass through untouched — preserving
  // backpressure for large uploads and avoiding the maxBufferedBodyBytes
  // cap on requests that don't need it.
  const body = bufferStreamBodies
    ? await bufferBody(rawBody, maxBufferedBodyBytes, signal)
    : rawBody;

  return {
    url,
    method: init?.method ?? req?.method ?? "GET",
    body,
    headers,
    carry,
    syntheticHost: false,
    originalRequest: req,
    headersAreFromRequest: req !== undefined && init?.headers === undefined,
    trustCustomTransport,
  };
}

function toInitWithoutHeaders(s: HopState): FetchInit {
  // Variant used on the Request-passthrough path. The passed Request
  // already carries its headers; overriding via init.headers would be
  // redundant and (in some runtimes) fails to replace Request headers
  // when we intended to preserve them.
  const init = toInit(s);
  delete (init as Record<string, unknown>).headers;
  return init;
}

function toInit(s: HopState): FetchInit {
  const omitBody = s.method === "GET" || s.method === "HEAD";
  // When the body is still stream-backed (redirect-skip path preserves
  // backpressure), Node 22 fetch REQUIRES duplex: "half" — stripping it
  // would make a valid streaming upload throw before any I/O. When the
  // body has been buffered into Uint8Array/etc., duplex is moot and we
  // strip it so the outgoing init accurately describes the payload.
  const bodyIsStream =
    !omitBody && (s.body instanceof ReadableStream || asyncIteratorOf(s.body) !== undefined);
  const carryInit: FetchInit = { ...s.carry };
  if (!bodyIsStream) {
    delete (carryInit as Record<string, unknown>).duplex;
  }
  return {
    ...carryInit,
    method: s.method,
    headers: s.headers,
    ...(omitBody ? {} : { body: s.body }),
    redirect: "manual",
  };
}

// Cross-origin redirects: switch from a denylist to an allowlist. Anything
// not in this set gets dropped on origin change because a server-side
// fetcher has no CORS signal telling us which custom headers are sensitive.
// x-api-key, x-amz-security-token, signed-request tokens, and per-vendor
// bearer schemes are far too common to enumerate safely.
const CROSS_ORIGIN_SAFE_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
  "content-type",
  "content-language",
  "cache-control",
  "pragma",
]);

function redactCrossOriginHeaders(headers: Headers): void {
  const toDelete: string[] = [];
  headers.forEach((_v, k) => {
    if (!CROSS_ORIGIN_SAFE_HEADERS.has(k.toLowerCase())) toDelete.push(k);
  });
  for (const name of toDelete) headers.delete(name);
}

function rewriteForRedirect(s: HopState, status: number, newUrl: string): void {
  const crossOrigin = new URL(s.url).origin !== new URL(newUrl).origin;
  const upperMethod = s.method.toUpperCase();

  // Compute the method downgrade that the Fetch spec applies on each status.
  //   303 → GET (except HEAD stays HEAD).
  //   301/302 + POST → GET (browser-aligned; spec says preserve, most UAs downgrade).
  //   307/308 → preserve method + body.
  const downgrade =
    (status === 303 && upperMethod !== "HEAD") ||
    ((status === 301 || status === 302) && upperMethod === "POST");

  // Refuse cross-origin redirects that would still forward a body after any
  // downgrade. Covers 307/308 for every method (body always preserved) AND
  // 301/302 for non-POST methods like PUT/PATCH (body preserved — our
  // downgrade only fires for POST). An attacker-controlled upstream can
  // otherwise answer PUT with 302 Location: attacker and exfiltrate the
  // original payload (API keys in JSON, signed body, etc.) cross-origin.
  const hasBody = s.body !== null && s.body !== undefined;
  if (crossOrigin && !downgrade && hasBody) {
    throw new Error(
      `url-safety: refused cross-origin ${status} redirect — body replay to ${newUrl} would leak the original ${upperMethod} payload to a different origin; if this is intentional, re-issue the request manually against the redirect target`,
    );
  }

  s.url = newUrl;

  if (downgrade) {
    s.method = "GET";
    s.body = undefined;
    s.headers.delete("content-length");
    s.headers.delete("content-type");
    s.headers.delete("content-encoding");
    s.headers.delete("content-language");
    s.headers.delete("content-location");
  }

  if (crossOrigin) redactCrossOriginHeaders(s.headers);
}

/**
 * Build a pinned URL for a single IP. `parsed` is the already-parsed
 * original URL so the caller can reuse it. Mutates `state.headers` to
 * set Host and flips `state.syntheticHost` so subsequent hops know the
 * value was wrapper-injected (as opposed to a caller-supplied Host).
 */
function rewriteToIp(originalUrl: URL, ip: string, state: HopState): string {
  state.headers.set("host", originalUrl.host);
  state.syntheticHost = true;
  const p = new URL(originalUrl.href);
  p.hostname = ip.includes(":") ? `[${ip}]` : ip;
  return p.href;
}

// Methods safe to retry across validated IPs on a thrown fetch error.
// Restricted to genuinely read-only verbs (GET/HEAD) and the CORS preflight
// helper (OPTIONS). DELETE is idempotent in the HTTP spec but has real
// side effects — a first-backend connect that failed after dispatch may
// still have applied the delete, so replaying to a second IP could
// double-apply destructive work. PUT/POST/PATCH always excluded for the
// same ambiguous-failure reason.
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

function hasCustomTransport(carry: FetchInit): boolean {
  const c = carry as Record<string, unknown>;
  return c["dispatcher"] !== undefined || c["agent"] !== undefined;
}

function shouldPinHttp(url: string, check: SafeUrlResult): URL | undefined {
  if (!check.ok) return undefined;
  if (check.resolvedIps.length === 0) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:") return undefined;
  // Already an IP literal — hostname matches one of the resolvedIps; no rewrite.
  // Node's URL.hostname keeps brackets around IPv6 literals (`[2001:db8::1]`)
  // while isSafeUrl stores the bare literal; strip before comparing so v6
  // literals short-circuit like v4 literals do.
  const bareHostname =
    parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
  if (check.resolvedIps.includes(bareHostname)) return undefined;
  return parsed;
}

/**
 * Perform a single outbound fetch with HTTP IP pinning.
 *
 *   HTTPS or IP-literal: pass through to `base(url, init)`.
 *   HTTP with N resolved IPs: try each IP in order, rewriting the URL to
 *     that IP + setting the Host header. On a thrown error (connect /
 *     TLS / transient network) fall through to the next IP. If the fetch
 *     returns a Response (any status), that IP succeeded — return it.
 *     Closes the DNS-rebind window AND preserves multi-address failover
 *     (all IPs were validated already, so every attempt is safe).
 *
 * AbortError short-circuits the loop.
 */
async function fetchWithPin(
  base: typeof fetch,
  url: string,
  check: SafeUrlResult,
  state: HopState,
): Promise<Response> {
  const parsed = shouldPinHttp(url, check);
  if (parsed === undefined) {
    // Request passthrough preserves internal transport state (undici
    // dispatcher on symbols, agent, etc.) — BUT also smuggles that
    // transport past trustCustomTransport because we can't introspect
    // the internal symbols. Gate passthrough on explicit opt-in so the
    // default path is fail-closed. When not trusted, always reconstruct
    // from URL + init.
    const passthrough = state.originalRequest;
    state.originalRequest = undefined;
    if (passthrough !== undefined && state.headersAreFromRequest && state.trustCustomTransport) {
      return base(passthrough, toInitWithoutHeaders(state));
    }
    return base(url, toInit(state));
  }
  // Pinned path: URL is rewritten to an IP, so we can't preserve the
  // original Request object.
  state.originalRequest = undefined;

  const canRetry = IDEMPOTENT_METHODS.has(state.method.toUpperCase());
  let lastError: unknown;
  for (const ip of check.ok ? check.resolvedIps : []) {
    const pinnedUrl = rewriteToIp(parsed, ip, state);
    try {
      return await base(pinnedUrl, toInit(state));
    } catch (e: unknown) {
      // AbortError must propagate — never silently retry a cancelled request.
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      lastError = e;
      // Only retry across IPs for idempotent methods. A thrown fetch error
      // on POST/PUT/PATCH is ambiguous (the request may already have been
      // sent to the first backend); replaying it could double-submit.
      if (!canRetry) throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("url-safety: all pinned IPs failed");
}

export function createSafeFetcher(
  base: typeof fetch = fetch,
  options?: SafeFetcherOptions,
): typeof fetch {
  const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBufferedBodyBytes = options?.maxBufferedBodyBytes ?? DEFAULT_MAX_BUFFERED_BODY_BYTES;
  const trustCustomTransport = options?.trustCustomTransport === true;
  const allowCustomHost = options?.allowCustomHost === true;

  const safeFetchImpl = async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    // Validate the URL BEFORE touching the body so blocked/malformed
    // destinations fail fast without consuming stream memory.
    const initialUrl = extractUrl(input);
    let check = await isSafeUrl(initialUrl, options);
    if (!check.ok) {
      throw new Error(`url-safety: ${check.reason}`);
    }

    const req = input instanceof Request ? input : undefined;
    const effectiveRedirect: FetchInit["redirect"] = init?.redirect ?? req?.redirect ?? "follow";

    // Custom transport rejection must happen BEFORE body buffering. Otherwise
    // a stream upload gets drained for a request that's going to throw — the
    // stream is already disturbed, the caller can't retry without rebuilding
    // the body, and we just wasted up to maxBufferedBodyBytes of memory.
    //
    // NOTE: Request objects store dispatcher/agent on internal symbols that
    // can't be introspected from JS. We can only detect init-level transport
    // here. Request-scoped transport state (if any) is preserved by passing
    // the Request through to base on hop 0, documented on
    // SafeFetcherOptions.trustCustomTransport.
    const carrierDispatcher = (init as Record<string, unknown> | undefined)?.["dispatcher"];
    const carrierAgent = (init as Record<string, unknown> | undefined)?.["agent"];
    if (!trustCustomTransport && (carrierDispatcher !== undefined || carrierAgent !== undefined)) {
      throw new Error(
        "url-safety: refused — a caller-supplied dispatcher/agent can bypass the validated address set; " +
          "drop the custom transport to use built-in IP pinning, or set trustCustomTransport: true to opt in explicitly " +
          "(only when the transport itself enforces an equivalent egress policy).",
      );
    }

    // Host authority check. On HTTPS the wrapper can't pin to the validated
    // IP, so a mismatched Host lets reverse proxies route the request to a
    // different vhost/tenant than isSafeUrl approved. Reject by default;
    // callers who need custom Host (internal signed-request flows) must
    // opt in with allowCustomHost and validate authority themselves.
    if (!allowCustomHost) {
      const callerHeaders = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      if (callerHeaders.has("host")) {
        throw new Error(
          "url-safety: refused — caller-supplied Host header can steer HTTPS to a different vhost than isSafeUrl validated. " +
            "Remove the Host header or set allowCustomHost: true (and validate the effective authority yourself).",
        );
      }
    }

    // Only pre-buffer streaming bodies when redirect-replay might happen.
    // redirect: "manual" / "error" never follows, so streams pass through.
    const bufferStreamBodies = effectiveRedirect === "follow" && maxRedirects > 0;
    const state = await buildState(
      input,
      init,
      maxBufferedBodyBytes,
      bufferStreamBodies,
      trustCustomTransport,
    );

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      // Only clear Host if WE set it (pin-synthetic). A caller-supplied
      // Host (for virtual-host routing, request signing, proxy dispatch,
      // etc.) must survive non-pinned hops and across redirects.
      if (state.syntheticHost) {
        state.headers.delete("host");
        state.syntheticHost = false;
      }

      // Re-validate at the TOP of every iteration — including hop 0 after
      // buildState. A slow body-buffer stretches the TOCTOU window between
      // the pre-buildState validation and the actual socket connect. For
      // HTTPS the wrapper can't rewrite the URL to the IP (TLS SNI), so
      // narrowing the window is the best we can do without a custom
      // dispatcher that separates SNI from the socket address.
      check = await isSafeUrl(state.url, options);
      if (!check.ok) {
        throw new Error(`url-safety: ${check.reason}`);
      }

      const response = await fetchWithPin(base, state.url, check, state);

      // Only 301/302/303/307/308 are redirect statuses per the Fetch spec.
      // 300 (Multiple Choices), 304 (Not Modified), 305 (Use Proxy, deprecated),
      // and 306 (Reserved) are NOT redirects — returning them directly avoids
      // duplicating requests / crossing origins on hostile 3xx responses that
      // native fetch would surface to the caller untouched.
      const isRedirectStatus =
        response.status === 301 ||
        response.status === 302 ||
        response.status === 303 ||
        response.status === 307 ||
        response.status === 308;
      if (!isRedirectStatus) {
        return response;
      }

      // Honour the caller's redirect mode for real 3xx redirects.
      if (effectiveRedirect === "manual") return response;
      if (effectiveRedirect === "error") {
        await response.body?.cancel().catch(() => undefined);
        throw new TypeError(
          `url-safety: unexpected redirect (${response.status}) with redirect: "error"`,
        );
      }

      const location = response.headers.get("location");
      if (location === null) return response;

      // Release the 3xx body so undici can reuse the connection. Without
      // this, redirect-heavy or attacker-crafted chains pin sockets until GC.
      await response.body?.cancel().catch(() => undefined);

      const nextUrl = new URL(location, state.url).href;
      rewriteForRedirect(state, response.status, nextUrl);
    }

    throw new Error(`url-safety: exceeded ${maxRedirects} redirects`);
  };

  return safeFetchImpl as typeof fetch;
}
