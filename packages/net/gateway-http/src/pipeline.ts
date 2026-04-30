import { buildGatewayRequestEntry, type GatewayRequestRecord } from "./audit.js";
import type { ChannelRegistry } from "./channel.js";
import { isOriginAllowed } from "./cors.js";
import { computeSignature, verifyHmac } from "./hmac.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { NonceStore } from "./nonce.js";
import { parseBody } from "./parse.js";
import type { RateLimitStore } from "./rate-limit.js";
import { isWithinReplayWindow } from "./replay.js";
import { matchRoute, type RouteMatch } from "./routing.js";
import type {
  AuthAuditResult,
  AuthOutcome,
  ChannelRegistration,
  GatewayHttpConfig,
} from "./types.js";

// Decoy secret used for unknown-channel requests so timing matches a registered
// channel that fails HMAC. 64 hex chars matches typical webhook secret entropy.
const DUMMY_SECRET = "x".repeat(64);

const HEADER_TS = "X-Webhook-Timestamp";
const HEADER_SIG = "X-Webhook-Signature";
const HEADER_NONCE = "X-Webhook-Nonce";

const UNAUTH_BODY = "unauthorized";

export interface PipelineDeps {
  readonly config: GatewayHttpConfig;
  readonly channels: ChannelRegistry;
  readonly rateLimits: RateLimitStore;
  readonly nonces: NonceStore;
  readonly idempotency: IdempotencyStore;
  readonly clock: () => number;
  readonly dispatch: (sessionId: string, agentId: string, payload: unknown) => Promise<string>;
  readonly audit: (entry: ReturnType<typeof buildGatewayRequestEntry>) => void;
  readonly sourceAddr: string;
  readonly inFlight: { count: number };
}

type WebhookRoute = Extract<RouteMatch, { kind: "webhook" }>;

type VerifiedAuth = {
  readonly reg: ChannelRegistration;
  readonly payload: unknown;
  readonly outcome: AuthOutcome;
};

type AuthResult =
  | { readonly ok: true; readonly value: VerifiedAuth }
  | { readonly ok: false; readonly response: Response };

type DispatchResult =
  | { readonly ok: true; readonly frameId: string }
  | { readonly ok: false; readonly response: Response };

export async function runPipeline(req: Request, deps: PipelineDeps): Promise<Response> {
  const url = new URL(req.url);
  const route = matchRoute(req.method, url.pathname);

  // Pipeline only handles webhook ingestion. Non-webhook routes are server.ts's
  // job; defensive 404 if anyone calls runPipeline with the wrong shape.
  if (route.kind !== "webhook") {
    return new Response("not found", { status: 404 });
  }

  // Step 2: backpressure cap (pre-increment).
  if (deps.inFlight.count >= deps.config.maxInFlight) {
    emit(deps, route, 429, "rejected:overflow");
    return new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "1" },
    });
  }
  // Single event-loop scope: read/increment/decrement is safe without atomics
  // because there's no preemption between await points in the request scope.
  // Do NOT share inFlight across worker threads or processes.
  deps.inFlight.count += 1;
  try {
    return await runWebhook(req, deps, route);
  } finally {
    // Step 16: decrement in finally so throws don't leak the counter.
    deps.inFlight.count -= 1;
  }
}

async function runWebhook(
  req: Request,
  deps: PipelineDeps,
  route: WebhookRoute,
): Promise<Response> {
  // Step 3: CORS check on cross-origin requests (only when Origin present).
  const origin = req.headers.get("Origin");
  if (origin !== null && !isOriginAllowed(origin, deps.config.cors)) {
    emit(deps, route, 403, "rejected:auth");
    return new Response(null, { status: 403 });
  }

  // Step 1 cont'd: channel lookup with synthetic decoy on miss for timing parity.
  const channel = deps.channels.get(route.channel);

  // Step 4: front-door source-IP limiter.
  const sourceLimitResp = checkSourceLimit(deps, route);
  if (sourceLimitResp !== null) return sourceLimitResp;

  // Step 5: body read with size cap (raw bytes; decode happens post-HMAC).
  const rawBytes = await readBoundedBody(req, deps.config.maxBodyBytes);
  if (rawBytes === null) {
    emit(deps, route, 413, "rejected:invalid-body");
    return new Response("payload too large", { status: 413 });
  }

  // Steps 6-9: HMAC verify, replay window, parse, channel.authenticate.
  const auth = await verifyAndAuth(req, route, rawBytes, channel, deps);
  if (!auth.ok) return auth.response;
  const { reg, payload, outcome } = auth.value;

  // Steps 10-11: per-tenant nonce + tenant rate limit.
  const tenantResp = applyTenantGates(reg, outcome, req, deps, route);
  if (tenantResp !== null) return tenantResp;

  return await dispatchAndCache(req, deps, route, reg, outcome, payload);
}

function checkSourceLimit(deps: PipelineDeps, route: WebhookRoute): Response | null {
  if (deps.config.sourceLimit === "disabled-acknowledged") return null;
  const r = deps.rateLimits.consumeSource(deps.sourceAddr, deps.config.sourceLimit);
  if (r.allowed) return null;
  emit(deps, route, 429, "rejected:rate-limit-source");
  return new Response("rate limited", {
    status: 429,
    headers: { "Retry-After": String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) },
  });
}

async function verifyAndAuth(
  req: Request,
  route: WebhookRoute,
  rawBytes: Uint8Array,
  channel: ChannelRegistration | undefined,
  deps: PipelineDeps,
): Promise<AuthResult> {
  const ts = req.headers.get(HEADER_TS) ?? "";
  const sig = req.headers.get(HEADER_SIG) ?? "";

  // Step 6: HMAC verify on raw bytes (always; even with decoy for timing parity).
  const sigOk = verifyHmac(channel?.secret ?? DUMMY_SECRET, ts, rawBytes, sig);
  if (!sigOk || channel === undefined) {
    // Dummy compute on unknown-channel path keeps timing close to the
    // registered-channel HMAC failure path even when verifyHmac short-circuits.
    if (channel === undefined) computeSignature(DUMMY_SECRET, ts, rawBytes);
    return rejectAuth(deps, route, "rejected:auth");
  }
  const reg = channel;

  // Step 7: replay timestamp window only.
  const nowSec = Math.floor(deps.clock() / 1000);
  if (!isWithinReplayWindow(nowSec, Number(ts), deps.config.replayWindowSeconds)) {
    return rejectAuth(deps, route, "rejected:replay");
  }

  // Step 8: parse body (post-HMAC). Decode UTF-8 only after signature verifies
  // so corrupted bytes can't propagate past the trust boundary.
  const rawBody = new TextDecoder("utf-8", { fatal: false }).decode(rawBytes);
  const parsed = parseBody(rawBody, req.headers.get("Content-Type"), reg.parseBody);
  if (!parsed.ok) {
    emit(deps, route, 400, "rejected:invalid-body");
    return {
      ok: false,
      response: new Response(JSON.stringify({ ok: false, code: "INVALID_BODY" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  // Step 9: authenticate (channel-specific; receives parsed payload + decoded body).
  const authResult = await reg.authenticate(req, rawBody, parsed.value, reg.secret);
  if (!authResult.ok) return rejectAuth(deps, route, "rejected:auth");
  return { ok: true, value: { reg, payload: parsed.value, outcome: authResult.value } };
}

function rejectAuth(
  deps: PipelineDeps,
  route: WebhookRoute,
  reason: AuthAuditResult,
): { readonly ok: false; readonly response: Response } {
  emit(deps, route, 401, reason);
  return { ok: false, response: new Response(UNAUTH_BODY, { status: 401 }) };
}

function applyTenantGates(
  reg: ChannelRegistration,
  outcome: AuthOutcome,
  req: Request,
  deps: PipelineDeps,
  route: WebhookRoute,
): Response | null {
  // Step 10: per-tenant nonce check.
  if (reg.replayProtection === "nonce") {
    const nonce = req.headers.get(HEADER_NONCE) ?? "";
    if (nonce.length === 0 || !deps.nonces.checkAndInsert(reg.id, outcome.tenantId, nonce)) {
      emit(deps, route, 401, "rejected:replay");
      return new Response(UNAUTH_BODY, { status: 401 });
    }
  }

  // Step 11: tenant rate limit (only if reg.rateLimit set).
  if (reg.rateLimit !== undefined) {
    const r = deps.rateLimits.consumeTenant(reg.id, outcome.tenantId, reg.rateLimit);
    if (!r.allowed) {
      emit(deps, route, 429, "rejected:rate-limit-tenant");
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) },
      });
    }
  }
  return null;
}

async function dispatchAndCache(
  req: Request,
  deps: PipelineDeps,
  route: WebhookRoute,
  reg: ChannelRegistration,
  outcome: AuthOutcome,
  payload: unknown,
): Promise<Response> {
  // Step 12: resolve session.
  const sessionResolution =
    reg.resolveSession === undefined ? "create" : await reg.resolveSession(req, outcome);
  const sessionId =
    sessionResolution === "create" ? `webhook-${crypto.randomUUID()}` : sessionResolution;

  // Step 13: idempotency reservation.
  const deliveryId = reg.extractDeliveryId(req, payload);
  const reservationResp = reserveDelivery(deps, route, reg, outcome, deliveryId, sessionId);
  if (reservationResp !== null) return reservationResp;

  // Step 14: dispatch (with cleanup on throw).
  const dispatchResult = await runDispatchWithCleanup(
    reg,
    outcome,
    sessionId,
    deliveryId,
    payload,
    deps,
    route,
  );
  if (!dispatchResult.ok) return dispatchResult.response;

  // Step 15: respond + cache (only on success).
  const responseBody = JSON.stringify({ ok: true, frameId: dispatchResult.frameId });
  if (deliveryId !== undefined) {
    deps.idempotency.complete(reg.id, outcome.tenantId, deliveryId, {
      status: 200,
      body: responseBody,
      frameId: dispatchResult.frameId,
    });
  }
  emit(deps, route, 200, "ok", sessionId);
  return new Response(responseBody, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function reserveDelivery(
  deps: PipelineDeps,
  route: WebhookRoute,
  reg: ChannelRegistration,
  outcome: AuthOutcome,
  deliveryId: string | undefined,
  sessionId: string,
): Response | null {
  if (deliveryId === undefined) return null;
  const reservation = deps.idempotency.reserve(reg.id, outcome.tenantId, deliveryId);
  if (reservation.kind === "in-flight") {
    emit(deps, route, 409, "idempotent-in-flight");
    return new Response(JSON.stringify({ ok: false, code: "DELIVERY_IN_FLIGHT" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (reservation.kind === "cached") {
    emit(deps, route, reservation.response.status, "idempotent-replay", sessionId);
    return new Response(reservation.response.body, {
      status: reservation.response.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

async function runDispatchWithCleanup(
  reg: ChannelRegistration,
  outcome: AuthOutcome,
  sessionId: string,
  deliveryId: string | undefined,
  payload: unknown,
  deps: PipelineDeps,
  route: WebhookRoute,
): Promise<DispatchResult> {
  try {
    const frameId = await deps.dispatch(sessionId, outcome.agentId, payload);
    return { ok: true, frameId };
  } catch (err: unknown) {
    if (deliveryId !== undefined) {
      deps.idempotency.clear(reg.id, outcome.tenantId, deliveryId);
    }
    // Auth succeeded — failure is downstream. authResult stays "ok"; the
    // status field (500) signals the dispatch failure to the audit log.
    // Reservation cleared so provider retry can re-attempt.
    emit(deps, route, 500, "ok", sessionId);
    void err;
    return { ok: false, response: new Response("internal error", { status: 500 }) };
  }
}

function emit(
  deps: PipelineDeps,
  route: WebhookRoute,
  status: number,
  authResult: AuthAuditResult,
  sessionId?: string,
): void {
  const path = `/webhooks/${route.channel}${route.account === undefined ? "" : `/${route.account}`}`;
  const record: GatewayRequestRecord = {
    timestamp: deps.clock(),
    kind: "gateway.request",
    channel: route.channel,
    path,
    method: "POST",
    status,
    // TODO: D3 (server.ts) will thread requestStartedAt into deps so we can
    // compute real latency. For now this records 0 for all entries.
    latencyMs: 0,
    authResult,
    ...(sessionId === undefined ? {} : { sessionId }),
    remoteAddr: deps.sourceAddr,
  };
  try {
    deps.audit(buildGatewayRequestEntry(record));
  } catch (err: unknown) {
    // Audit sink errors must never break a request. Swallow with diagnostic.
    // Caller wires sink with retry/metrics; we just don't propagate.
    void err;
  }
}

async function readBoundedBody(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  // Reject obvious overflows from declared Content-Length without ever
  // touching the body stream. Truthful clients pay zero allocation cost.
  const cl = req.headers.get("Content-Length");
  if (cl !== null) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) return null;
  }
  const body = req.body;
  if (body === null) return new Uint8Array(0);

  // Stream and abort once the cap is exceeded so chunked / lying-Content-Length
  // requests cannot force full materialization of an oversized payload.
  // Decoding to UTF-8 happens AFTER signature verification on the raw bytes.
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop receiving early: drop the reader's lock so the stream can be GC'd.
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
