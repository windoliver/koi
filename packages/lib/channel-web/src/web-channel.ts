/**
 * Web (HTTP + WebSocket) channel adapter.
 *
 * Bun.serve-based: WebSocket push for outbound streaming, REST POST for
 * inbound messages. Built on @koi/channel-base/createChannelAdapter() for
 * lifecycle, capability-aware rendering, and handler dispatch.
 */

import { createChannelAdapter } from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  InboundMessage,
  JsonObject,
  OutboundMessage,
} from "@koi/core";
import type { ServerWebSocket } from "bun";

const MAX_BODY_BYTES = 1_000_000;
/** Idempotency window: how long to remember a client-supplied message ID. */
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
/** Hard cap on stored idempotency keys (OOM backstop). */
const IDEMPOTENCY_HIGH_WATER = 50_000;

/**
 * Read the request body as a UTF-8 string, aborting once the byte cap is
 * exceeded. Returns `null` if the request would have exceeded `cap` bytes
 * (caller responds 413). Streaming counter rather than `await req.text()`
 * defeats: (1) clients that omit/understate Content-Length, (2) chunked
 * bodies, (3) multibyte payloads that pass a character-count check but
 * exceed the byte budget.
 */
async function readBodyWithCap(req: Request, cap: number): Promise<string | null> {
  const reader = req.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder("utf-8");
  // let requires justification: accumulator for streamed body chunks
  let chunks = "";
  // let requires justification: byte counter for the streaming cap
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      // best-effort cancel so we don't continue receiving bytes we'll discard
      try {
        await reader.cancel();
      } catch {
        // already terminated — ignore
      }
      return null;
    }
    chunks += decoder.decode(value, { stream: true });
  }
  chunks += decoder.decode();
  return chunks;
}

const WEB_CAPABILITIES = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

/**
 * Authentication context — what the host gives `authenticate()` to make
 * an authorization decision. `threadId` is the thread the caller is asking
 * to interact with (from `?thread=` on `/ws` upgrade or the JSON body on
 * `/messages` POST). The host is responsible for deciding whether the
 * authenticated principal is allowed to subscribe / post to that thread.
 */
export interface WebAuthContext {
  readonly token: string | null;
  readonly threadId: string | undefined;
  readonly request: Request;
}

/**
 * Authentication result — when accepted, the host MUST return the principal's
 * `senderId`. The transport never trusts a `senderId` claimed by the request
 * body; the auth-derived value is what we attribute the inbound message to.
 */
export interface WebAuthResult {
  readonly senderId: string;
}

export interface WebChannelConfig {
  readonly port?: number;
  readonly hostname?: string;
  readonly path?: string;
  /**
   * Default sender ID stamped on inbound messages in open mode. Only honoured
   * when `allowUnauthenticated: true` is explicitly set; otherwise the channel
   * fails closed at construction time.
   */
  readonly senderId?: string;
  /**
   * Authorize a request and resolve the principal. Receives the bearer
   * token, the thread the caller is asking to interact with, and the raw
   * request. Returns `null` to deny (`401`), or `{ senderId }` to allow.
   *
   * The host is responsible for deciding whether the authenticated principal
   * may subscribe / post to the given `threadId`. Returning `null` for an
   * unauthorized thread enforces multi-tenant isolation at the boundary.
   */
  readonly authenticate?: (
    ctx: WebAuthContext,
  ) => WebAuthResult | null | Promise<WebAuthResult | null>;
  /**
   * Explicit opt-in to OPEN (no-auth) mode. When `true` AND `authenticate` is
   * omitted, every request is accepted and stamped with `senderId`. Use ONLY
   * for local development, demos, or controlled-network deployments.
   *
   * `createWebChannel` throws if `authenticate` is omitted and this flag is
   * not set, preventing accidental production deploys with no auth.
   */
  readonly allowUnauthenticated?: boolean;
  readonly originAllowList?: readonly string[] | undefined;
  /**
   * Opt out of the cross-origin fail-closed default. When `authenticate` is
   * configured, the constructor refuses to start unless `originAllowList` is
   * also set — this prevents CSRF-style abuse for hosts that authenticate
   * via browser-ambient credentials (cookies, etc.). Setting this to `true`
   * allows any origin and is ONLY safe when the host's auth scheme is not
   * browser-ambient (e.g. tokens issued and managed entirely by your own JS).
   */
  readonly allowAnyOrigin?: boolean;
  /**
   * Visibility hook for handler failures during async dispatch. The HTTP
   * response is sent BEFORE handlers complete (per channel-base's
   * fire-and-forget Promise.allSettled), so a handler that throws after
   * the 202 is silent loss as far as the HTTP client is concerned. Hosts
   * needing durability MUST use this hook to enqueue the failed
   * `InboundMessage` to their own DLQ / durable storage.
   */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
}

export interface WebChannelAdapter extends ChannelAdapter {
  /** TCP port the underlying Bun.serve is bound to (`0` selects a random port). */
  readonly port: number;
  /**
   * Close every WebSocket subscription whose stored principal/thread matches
   * `predicate`. Use this from the host whenever an entitlement changes
   * (logout, token revoked, removed-from-thread, role downgrade). Returns
   * the number of sockets closed.
   *
   * The predicate receives the same `{ senderId, threadId }` that
   * `authenticate()` produced at upgrade time. Returning `true` closes the
   * socket with code `1008` (policy violation).
   */
  readonly revokeSubscriptions: (
    predicate: (subscriber: {
      readonly senderId: string;
      readonly threadId: string | undefined;
    }) => boolean,
  ) => number;
}

interface RawInbound {
  readonly senderId?: unknown;
  readonly threadId?: unknown;
  readonly content?: unknown;
  readonly metadata?: unknown;
}

/**
 * Validate one content block. We require a known `kind` plus the fields that
 * `kind` mandates so malformed blocks are rejected synchronously at the HTTP
 * boundary — never accepted with 202 and discovered as undeliverable later.
 */
function isContentBlock(b: unknown): b is ContentBlock {
  if (typeof b !== "object" || b === null) return false;
  const r = b as { readonly kind?: unknown; readonly text?: unknown; readonly url?: unknown };
  switch (r.kind) {
    case "text":
      return typeof r.text === "string";
    case "image":
    case "file":
      return typeof r.url === "string";
    case "button":
      return (
        typeof (r as { readonly label?: unknown }).label === "string" &&
        typeof (r as { readonly value?: unknown }).value === "string"
      );
    case "custom":
      return true;
    default:
      return false;
  }
}

/**
 * Validate an inbound payload and convert to InboundMessage. The senderId is
 * NEVER taken from the request body — it must come from the verified principal
 * passed in by the caller. This prevents impersonation at the HTTP boundary.
 */
function parseInbound(raw: unknown, principalSenderId: string): InboundMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as RawInbound;
  if (!Array.isArray(r.content) || r.content.length === 0) return null;
  if (!r.content.every(isContentBlock)) return null;
  const threadId = typeof r.threadId === "string" ? r.threadId : undefined;
  const metadata =
    typeof r.metadata === "object" && r.metadata !== null ? (r.metadata as JsonObject) : undefined;
  return {
    content: r.content as readonly ContentBlock[],
    senderId: principalSenderId,
    timestamp: Date.now(),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/**
 * Extract bearer token from `Authorization: Bearer <t>`, or `null`.
 */
function bearerOf(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(h);
  return match?.[1] ?? null;
}

/**
 * Extract a single named cookie from the `Cookie` header, or `null`.
 * Strict semantics: the cookie name must match exactly; values are not
 * URL-decoded (the host validates the token format).
 */
function cookieOf(req: Request, name: string): string | null {
  const h = req.headers.get("cookie");
  if (h === null) return null;
  for (const part of h.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

/**
 * Resolve a credential for the WebSocket upgrade path. Sources in priority
 * order:
 *   1. `Authorization: Bearer <t>` header (preferred for non-browser clients)
 *   2. `koi_ws` cookie — browsers DO send cookies on WebSocket upgrades, so
 *      this is the safest browser path: credentials never enter the URL.
 *   3. `?token=<t>` query string — accepted ONLY as a last resort. URL
 *      tokens leak through access logs, proxy logs, browser history, and
 *      crash reports; hosts SHOULD treat any `?token=` as a single-use,
 *      short-lived ticket and revoke it on first consumption (the
 *      `authenticate` callback owns this policy).
 *
 * NEVER call this for `POST /messages` — that path requires
 * `Authorization: Bearer` only, no URL fallback.
 */
function upgradeCredentialOf(req: Request, url: URL): string | null {
  return bearerOf(req) ?? cookieOf(req, "koi_ws") ?? url.searchParams.get("token");
}

/**
 * Creates a Bun.serve-backed ChannelAdapter for browser/HTTP clients.
 */
export function createWebChannel(config: WebChannelConfig = {}): WebChannelAdapter {
  const port = config.port ?? 0;
  const hostname = config.hostname ?? "127.0.0.1";
  const defaultSenderId = config.senderId ?? "web-user";
  const path = (config.path ?? "/").replace(/\/$/, "");
  const authenticate = config.authenticate;
  const allowList = config.originAllowList;

  // Fail closed: refuse to construct an adapter that has no authentication
  // configured AND no explicit opt-in for unauthenticated mode. This stops a
  // production misconfiguration from silently exposing an open agent endpoint.
  if (authenticate === undefined && config.allowUnauthenticated !== true) {
    throw new Error(
      "[channel-web] no authentication configured. Either pass `authenticate` " +
        "or set `allowUnauthenticated: true` to explicitly opt into open mode " +
        "(local dev only).",
    );
  }

  // Fail closed against CSRF-style cross-origin abuse: when the host wires
  // browser-managed credentials (cookies, ambient bearer tokens via
  // `authenticate`) we MUST require an explicit `originAllowList`. Without
  // it, any third-party origin could drive authenticated POSTs and WS
  // upgrades into the agent endpoint. Hosts that want any-origin behavior
  // must opt in deliberately.
  if (authenticate !== undefined && allowList === undefined && config.allowAnyOrigin !== true) {
    throw new Error(
      "[channel-web] authenticated transport requires an explicit `originAllowList`. " +
        "Pass the array of trusted browser origins, or set `allowAnyOrigin: true` " +
        "(only safe when the auth scheme is not browser-ambient — e.g. tokens " +
        "issued and managed entirely by your own JS).",
    );
  }

  // let requires justification: Bun.serve instance created/destroyed by lifecycle
  let server: ReturnType<typeof Bun.serve> | undefined;
  // let requires justification: emit handler captured during onPlatformEvent
  let emit: ((m: InboundMessage) => void) | undefined;
  // let requires justification: counts active onMessage subscribers so HTTP
  // ingress can refuse 202 when there's nobody to deliver to (no silent drop).
  let handlerCount = 0;
  // Idempotency cache for client-supplied `Idempotency-Key` headers.
  // Split into has/commit so a request that fails before dispatch (e.g.
  // 503 no-handler) does NOT poison the key — a retry once a handler is
  // attached must still dispatch. Lazy TTL eviction with high-water OOM
  // backstop.
  const idempotency = new Map<string, number>();
  function sweepIdempotency(nowMs: number): void {
    for (const [k, exp] of idempotency) {
      if (exp > nowMs) return;
      idempotency.delete(k);
    }
  }
  function hasIdempotencyKey(key: string, nowMs: number): boolean {
    sweepIdempotency(nowMs);
    return idempotency.has(key);
  }
  function commitIdempotencyKey(key: string, nowMs: number): void {
    sweepIdempotency(nowMs);
    while (idempotency.size >= IDEMPOTENCY_HIGH_WATER) {
      const oldest = idempotency.keys().next().value;
      if (oldest === undefined) break;
      idempotency.delete(oldest);
    }
    idempotency.set(key, nowMs + IDEMPOTENCY_TTL_MS);
  }
  // let requires justification: live WS subscribers tagged with the principal
  // and thread they were authorized for. Routing uses `threadId` exclusively.
  let sockets: ReadonlySet<
    ServerWebSocket<{
      readonly threadId: string | undefined;
      readonly senderId: string;
    }>
  > = new Set();

  function originDenied(req: Request): boolean {
    if (allowList === undefined) return false;
    const origin = req.headers.get("origin");
    if (origin === null) return false;
    return !allowList.includes(origin);
  }

  /**
   * Build CORS headers for an allowed cross-origin request. When no allow-list
   * is configured, every origin is reflected (open mode); when the request's
   * origin is in the list, that exact origin is echoed back. Without these
   * headers, browsers block any non-same-origin POST that includes auth.
   */
  function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin");
    if (origin === null) return {};
    if (allowList !== undefined && !allowList.includes(origin)) return {};
    const reqHeaders = req.headers.get("access-control-request-headers");
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": reqHeaders ?? "authorization, content-type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  }

  /** Apply CORS headers to a response (no-op when origin isn't allowed). */
  function withCors(req: Request, response: Response): Response {
    const headers = corsHeaders(req);
    if (Object.keys(headers).length === 0) return response;
    const merged = new Headers(response.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: merged,
    });
  }

  /**
   * Run the configured authenticator. Returns the resolved principal on
   * success, or null to deny. In open mode (no `authenticate` configured),
   * stamps every request with `config.senderId` — local dev only.
   */
  async function authorize(
    req: Request,
    token: string | null,
    threadId: string | undefined,
  ): Promise<WebAuthResult | null> {
    if (authenticate === undefined) {
      return { senderId: defaultSenderId };
    }
    return authenticate({ token, threadId, request: req });
  }

  async function handleMessages(req: Request, _url: URL): Promise<Response> {
    if (originDenied(req)) return new Response("Forbidden", { status: 403 });

    // Body-size guard: streaming byte cap so unauthenticated clients cannot
    // force the server to buffer arbitrarily large payloads. We trust
    // Content-Length only as a fast-path rejection — the authoritative limit
    // is enforced by counting bytes off the body stream and aborting once
    // the cap is exceeded. This also defeats character-vs-byte mismatches
    // (multibyte UTF-8 strings exceeding the cap when measured in bytes).
    const len = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return new Response("Payload Too Large", { status: 413 });
    }
    const text = await readBodyWithCap(req, MAX_BODY_BYTES);
    if (text === null) {
      return new Response("Payload Too Large", { status: 413 });
    }
    // let requires justification: parsed JSON typed via try/catch
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (typeof parsed !== "object" || parsed === null) {
      return new Response("Invalid payload", { status: 400 });
    }
    const raw = parsed as RawInbound;
    const claimedThreadId = typeof raw.threadId === "string" ? raw.threadId : undefined;

    // Authorize WITH the thread context so the host can deny cross-tenant access.
    // POST /messages takes the token from `Authorization: Bearer <t>` ONLY —
    // never `?token=` query. URL tokens leak via logs/history; the query
    // fallback exists solely for the WebSocket upgrade path where browsers
    // cannot set custom headers.
    const principal = await authorize(req, bearerOf(req), claimedThreadId);
    if (principal === null) return new Response("Unauthorized", { status: 401 });

    const message = parseInbound(parsed, principal.senderId);
    if (message === null) return new Response("Invalid payload", { status: 400 });

    // Optional client-supplied idempotency key — caller opts in by sending
    // `Idempotency-Key: <unique>`. Already-committed retry → 202 with no
    // re-dispatch. Without the header, every POST dispatches.
    const idemKey = req.headers.get("idempotency-key");
    const now = Date.now();
    if (idemKey !== null && idemKey.length > 0 && hasIdempotencyKey(idemKey, now)) {
      return new Response(null, { status: 202 });
    }

    // Refuse to silently drop: if no listener is attached we have nobody
    // to deliver to. Returning 503 BEFORE committing the idempotency key
    // means a retry once a handler is attached will still dispatch.
    if (emit === undefined || handlerCount === 0) {
      return new Response("No handler registered", { status: 503 });
    }
    emit(message);
    // Commit idempotency key AFTER successful dispatch so failed
    // attempts (503/etc) do not poison future retries.
    if (idemKey !== null && idemKey.length > 0) {
      commitIdempotencyKey(idemKey, now);
    }
    return new Response(null, { status: 202 });
  }

  /**
   * Strict per-thread routing — never lets one client see another's replies.
   *
   * - Threaded outbound  (`message.threadId !== undefined`): delivered ONLY
   *   to sockets that subscribed to that exact thread (`?thread=<id>`).
   *   Unscoped sockets do NOT receive threaded replies.
   * - Unscoped outbound  (`message.threadId === undefined`): delivered ONLY
   *   to unscoped sockets. Threaded subscribers do NOT receive cross-thread
   *   broadcasts.
   *
   * This is a trust boundary, not a UX feature: two authenticated clients
   * subscribed to different threads must NEVER observe each other's traffic.
   */
  function route(message: OutboundMessage, payload: string): void {
    const target = message.threadId;
    for (const ws of sockets) {
      const tag = ws.data?.threadId;
      if (tag !== target) continue;
      try {
        ws.send(payload);
      } catch {
        // socket may be closing — ignore
      }
    }
  }

  const base = createChannelAdapter<InboundMessage>({
    name: "web",
    capabilities: WEB_CAPABILITIES,

    platformConnect: async () => {
      server = Bun.serve({
        port,
        hostname,
        fetch: async (req, srv) => {
          const url = new URL(req.url);
          // Strict leading-prefix match — `url.pathname.replace(path, "")`
          // matches anywhere, so a request to `/messages` would be routed
          // even when `config.path` is `/api`, exposing a second ingress
          // outside the configured namespace. Require the prefix at the
          // start, then take what follows; reject anything else with 404.
          // let requires justification: route resolved through prefix check
          let route: string;
          if (path === "" || path === "/") {
            route = url.pathname || "/";
          } else if (url.pathname === path) {
            route = "/";
          } else if (url.pathname.startsWith(`${path}/`)) {
            route = url.pathname.slice(path.length);
          } else {
            return new Response("Not Found", { status: 404 });
          }

          // CORS preflight — must answer for every cross-origin browser POST.
          // Without this, browsers block the request before /messages is even
          // hit. Only allowed origins receive permissive headers.
          if (req.method === "OPTIONS") {
            if (originDenied(req)) return new Response("Forbidden", { status: 403 });
            return withCors(req, new Response(null, { status: 204 }));
          }

          if (route === "/ws") {
            if (originDenied(req)) return new Response("Forbidden", { status: 403 });
            const threadId = url.searchParams.get("thread") ?? undefined;
            // Fail closed against shared unscoped broadcast: in authenticated
            // mode, a `?thread=` is REQUIRED. Without it, every unscoped
            // subscriber would land in the same global bucket and an
            // unthreaded outbound message would broadcast across tenants.
            // Open mode keeps the unscoped path for local dev convenience.
            if (threadId === undefined && authenticate !== undefined) {
              return new Response("Bad Request: thread parameter required", { status: 400 });
            }
            const principal = await authorize(req, upgradeCredentialOf(req, url), threadId);
            if (principal === null) return new Response("Unauthorized", { status: 401 });
            if (srv.upgrade(req, { data: { threadId, senderId: principal.senderId } })) {
              return undefined as unknown as Response;
            }
            return new Response("Upgrade failed", { status: 400 });
          }

          if (route === "/messages" && req.method === "POST") {
            return withCors(req, await handleMessages(req, url));
          }

          return new Response("Not Found", { status: 404 });
        },
        websocket: {
          open: (
            ws: ServerWebSocket<{
              readonly threadId: string | undefined;
              readonly senderId: string;
            }>,
          ) => {
            sockets = new Set([...sockets, ws]);
          },
          close: (
            ws: ServerWebSocket<{
              readonly threadId: string | undefined;
              readonly senderId: string;
            }>,
          ) => {
            const next = new Set(sockets);
            next.delete(ws);
            sockets = next;
          },
          message: () => {
            // inbound WS messages are not supported — clients POST to /messages
          },
        },
      });
    },

    platformDisconnect: async () => {
      server?.stop(true);
      server = undefined;
      sockets = new Set();
    },

    platformSend: async (message: OutboundMessage) => {
      // Authenticated deployments reject unscoped subscribers (`/ws` requires
      // `?thread=`), so an unthreaded outbound message has no valid recipient
      // class. Silently broadcasting to zero clients masks bugs in caller
      // code that forgot to pass `threadId`. Fail closed so the missing
      // routing decision is loud, not silent.
      if (message.threadId === undefined && authenticate !== undefined) {
        throw new Error(
          "[channel-web] cannot send: outbound message has no threadId, but " +
            "authenticated mode disallows unscoped subscribers. Pass `threadId` " +
            "to scope the send to a specific subscriber.",
        );
      }
      route(message, JSON.stringify(message));
    },

    onPlatformEvent: (handler) => {
      emit = (m) => handler(m);
      return () => {
        emit = undefined;
      };
    },

    // The HTTP layer already produced a finished InboundMessage; pass through.
    normalize: (m: InboundMessage) => m,

    // Forward handler failures so hosts can DLQ. We've already returned 202
    // before handlers run, so this hook is the ONLY visibility into post-ack
    // handler failures — silent loss otherwise.
    ...(config.onHandlerError !== undefined
      ? {
          onHandlerError: (err: unknown, message: InboundMessage) => {
            config.onHandlerError?.(err, message);
          },
        }
      : {}),
  });

  /**
   * Close every WebSocket whose stored principal/thread matches the predicate.
   * Returns the number closed. Used by hosts to revoke long-lived subscriptions
   * when an entitlement changes (logout, role downgrade, removed-from-thread).
   */
  function revokeSubscriptions(
    predicate: (s: { readonly senderId: string; readonly threadId: string | undefined }) => boolean,
  ): number {
    // Remove matching sockets from the routing set BEFORE closing so a
    // concurrent `route()` cannot deliver post-revocation traffic during
    // the async close handshake. Bun's `close` callback prunes again, but
    // the routing-visible set must shrink synchronously here for tenant
    // isolation under entitlement changes.
    const next = new Set(sockets);
    // let requires justification: counts how many sockets matched and were closed
    let count = 0;
    for (const ws of sockets) {
      const data = ws.data;
      if (!predicate({ senderId: data.senderId, threadId: data.threadId })) continue;
      next.delete(ws);
      try {
        ws.close(1008, "Subscription revoked");
        count++;
      } catch {
        // socket may already be closing — ignore
      }
    }
    sockets = next;
    return count;
  }

  // Wrap onMessage to track subscriber count — handleMessages uses it to
  // refuse 202 when there's nobody to deliver to.
  const tracked = {
    ...base,
    onMessage: (handler: Parameters<ChannelAdapter["onMessage"]>[0]): (() => void) => {
      handlerCount++;
      const unsub = base.onMessage(handler);
      // let requires justification: each subscription has its own active flag
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        handlerCount = Math.max(0, handlerCount - 1);
        unsub();
      };
    },
    revokeSubscriptions,
  };

  // defineProperty (not Object.assign / spread) so the getter stays live —
  // server.port is only known after platformConnect() runs.
  return Object.defineProperty({ ...tracked } as WebChannelAdapter, "port", {
    get: () => server?.port ?? 0,
    enumerable: true,
    configurable: false,
  });
}
