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
): Promise<HopState> {
  const req = input instanceof Request ? input : undefined;
  // Native fetch rejects with TypeError if the Request body was already
  // consumed upstream. Match that contract — otherwise buildState would
  // silently turn a mutating POST/PUT into an empty request to the target.
  if (req !== undefined && req.bodyUsed) {
    throw new TypeError(
      "url-safety: Request body is already consumed (bodyUsed=true); clone or re-create the Request before passing to safeFetch",
    );
  }
  const url = extractUrl(input);

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
  // Duplex must survive into the outgoing init: Node 22 fetch requires
  // duplex: "half" whenever a streaming (AsyncIterable) body is passed
  // through and we don't buffer it.
  pick("duplex" as keyof FetchInit);

  const signal = init?.signal ?? req?.signal;
  const rawBody = init?.body ?? (req !== undefined ? req.body : undefined);
  const body = await bufferBody(rawBody, maxBufferedBodyBytes, signal);

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
  // Body has been buffered to a Uint8Array (non-stream), so we can safely
  // drop any caller-provided `duplex` — Node 22 fetch only needs it for
  // streaming bodies, and carrying "half" forward with a buffered body
  // is benign but misleading about the outgoing request.
  const carryWithoutDuplex = { ...s.carry };
  delete (carryWithoutDuplex as Record<string, unknown>).duplex;
  return {
    ...carryWithoutDuplex,
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

  if (crossOrigin) redactCrossOriginHeaders(s.headers);
}

/**
 * Build a pinned URL for a single IP. `parsed` is the already-parsed
 * original URL so the caller can reuse it. Mutates `headers` to set Host.
 */
function rewriteToIp(originalUrl: URL, ip: string, headers: Headers): string {
  headers.set("host", originalUrl.host);
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

function shouldPinHttp(url: string, check: SafeUrlResult): URL | undefined {
  if (!check.ok) return undefined;
  if (check.resolvedIps.length === 0) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:") return undefined;
  // Already an IP literal — hostname matches one of the resolvedIps; no rewrite.
  if (check.resolvedIps.includes(parsed.hostname)) return undefined;
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
    state.headers.delete("host");
    return base(url, toInit(state));
  }

  const canRetry = IDEMPOTENT_METHODS.has(state.method.toUpperCase());
  let lastError: unknown;
  for (const ip of check.ok ? check.resolvedIps : []) {
    const pinnedUrl = rewriteToIp(parsed, ip, state.headers);
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

    const state = await buildState(input, init, maxBufferedBodyBytes);

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      // Host header is per-hop derived state.
      state.headers.delete("host");

      if (hop > 0) {
        check = await isSafeUrl(state.url, options);
        if (!check.ok) {
          throw new Error(`url-safety: ${check.reason}`);
        }
      }

      const response = await fetchWithPin(base, state.url, check, state);

      if (response.status < 300 || response.status >= 400) {
        return response;
      }

      // Honour the caller's redirect mode for 3xx responses.
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
