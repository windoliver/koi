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
  const effectiveSecret = channel?.secret ?? DUMMY_SECRET;

  // Step 4: front-door source-IP limiter (only when configured).
  if (deps.config.sourceLimit !== "disabled-acknowledged") {
    const r = deps.rateLimits.consumeSource(deps.sourceAddr, deps.config.sourceLimit);
    if (!r.allowed) {
      emit(deps, route, 429, "rejected:rate-limit-source");
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) },
      });
    }
  }

  // Step 5: body read with size cap.
  const rawBody = await readBoundedBody(req, deps.config.maxBodyBytes);
  if (rawBody === null) {
    emit(deps, route, 413, "rejected:invalid-body");
    return new Response("payload too large", { status: 413 });
  }

  // Step 6: HMAC verify (always; even with decoy for timing parity).
  const ts = req.headers.get(HEADER_TS) ?? "";
  const sig = req.headers.get(HEADER_SIG) ?? "";
  const sigOk = verifyHmac(effectiveSecret, ts, rawBody, sig);
  if (!sigOk || channel === undefined) {
    // Run a dummy compute on the unknown-channel path so timing stays close to
    // the registered-channel HMAC failure path even when verifyHmac short-circuits.
    if (channel === undefined) {
      computeSignature(DUMMY_SECRET, ts, rawBody);
    }
    emit(deps, route, 401, "rejected:auth");
    return new Response(UNAUTH_BODY, { status: 401 });
  }

  const reg = channel;

  // Step 7: replay timestamp window only.
  const tsNum = Number(ts);
  const nowSec = Math.floor(deps.clock() / 1000);
  if (!isWithinReplayWindow(nowSec, tsNum, deps.config.replayWindowSeconds)) {
    emit(deps, route, 401, "rejected:replay");
    return new Response(UNAUTH_BODY, { status: 401 });
  }

  // Step 8: parse body (pre-auth, gateway-canonical).
  const parsed = parseBody(rawBody, req.headers.get("Content-Type"), reg.parseBody);
  if (!parsed.ok) {
    emit(deps, route, 400, "rejected:invalid-body");
    return new Response(JSON.stringify({ ok: false, code: "INVALID_BODY" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Step 9: authenticate (channel-specific; receives parsed payload).
  const authResult = await reg.authenticate(req, rawBody, parsed.value, reg.secret);
  if (!authResult.ok) {
    emit(deps, route, 401, "rejected:auth");
    return new Response(UNAUTH_BODY, { status: 401 });
  }
  const outcome: AuthOutcome = authResult.value;

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

  return await dispatchAndCache(req, deps, route, reg, outcome, parsed.value);
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
  if (deliveryId !== undefined) {
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
  }

  // Step 14: dispatch.
  let frameId: string;
  try {
    frameId = await deps.dispatch(sessionId, outcome.agentId, payload);
  } catch (err: unknown) {
    if (deliveryId !== undefined) {
      deps.idempotency.clear(reg.id, outcome.tenantId, deliveryId);
    }
    // Auth succeeded — failure is downstream. authResult stays "ok"; the
    // status field (500) signals the dispatch failure to the audit log.
    // Reservation cleared so provider retry can re-attempt.
    emit(deps, route, 500, "ok", sessionId);
    void err;
    return new Response("internal error", { status: 500 });
  }

  // Step 15: respond + cache (only on success).
  const responseBody = JSON.stringify({ ok: true, frameId });
  if (deliveryId !== undefined) {
    deps.idempotency.complete(reg.id, outcome.tenantId, deliveryId, {
      status: 200,
      body: responseBody,
      frameId,
    });
  }
  emit(deps, route, 200, "ok", sessionId);
  return new Response(responseBody, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

async function readBoundedBody(req: Request, maxBytes: number): Promise<string | null> {
  const cl = req.headers.get("Content-Length");
  if (cl !== null) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) return null;
  }
  const text = await req.text();
  if (text.length > maxBytes) return null;
  return text;
}
