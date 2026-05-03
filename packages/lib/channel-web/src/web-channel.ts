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
 * Validate an inbound payload and convert to InboundMessage. The senderId is
 * NEVER taken from the request body — it must come from the verified principal
 * passed in by the caller. This prevents impersonation at the HTTP boundary.
 */
function parseInbound(raw: unknown, principalSenderId: string): InboundMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as RawInbound;
  if (!Array.isArray(r.content)) return null;
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
 * Pick a token for the WebSocket upgrade path only — header first, then
 * `?token=` query. Browser `WebSocket` clients can't set arbitrary headers,
 * so the query-string fallback is the practical path for browser subscribers.
 *
 * NEVER use this for `POST /messages`. Tokens in URLs leak through access
 * logs, proxy logs, and browser history; widening the query-fallback to
 * normal HTTP requests weakens the auth boundary for no functional gain
 * (regular HTTP clients can always set `Authorization`).
 */
function upgradeTokenOf(req: Request, url: URL): string | null {
  return bearerOf(req) ?? url.searchParams.get("token");
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

  // let requires justification: Bun.serve instance created/destroyed by lifecycle
  let server: ReturnType<typeof Bun.serve> | undefined;
  // let requires justification: emit handler captured during onPlatformEvent
  let emit: ((m: InboundMessage) => void) | undefined;
  // let requires justification: counts active onMessage subscribers so HTTP
  // ingress can refuse 202 when there's nobody to deliver to (no silent drop).
  let handlerCount = 0;
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

    // Body-size guard up-front so unauthenticated clients can't force the
    // server to buffer arbitrarily large payloads before being rejected.
    const len = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return new Response("Payload Too Large", { status: 413 });
    }
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
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

    // Refuse to silently drop: if no listener is attached we have nobody to
    // deliver to. 503 lets clients/proxies retry with backoff instead of
    // believing the message was processed.
    if (emit === undefined || handlerCount === 0) {
      return new Response("No handler registered", { status: 503 });
    }
    emit(message);
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
            const principal = await authorize(req, upgradeTokenOf(req, url), threadId);
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
  });

  /**
   * Close every WebSocket whose stored principal/thread matches the predicate.
   * Returns the number closed. Used by hosts to revoke long-lived subscriptions
   * when an entitlement changes (logout, role downgrade, removed-from-thread).
   */
  function revokeSubscriptions(
    predicate: (s: { readonly senderId: string; readonly threadId: string | undefined }) => boolean,
  ): number {
    // let requires justification: counts how many sockets matched and were closed
    let count = 0;
    for (const ws of sockets) {
      const data = ws.data;
      if (!predicate({ senderId: data.senderId, threadId: data.threadId })) continue;
      try {
        ws.close(1008, "Subscription revoked");
        count++;
      } catch {
        // socket may already be closing — ignore
      }
    }
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
