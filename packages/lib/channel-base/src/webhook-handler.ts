/**
 * @koi/channel-base — handleWebhookIngress: composable webhook flow.
 *
 * verify → tryBegin → parse → enqueue → 200/4xx/5xx
 *
 * Used by webhook-capable channels (Teams, WhatsApp) to bind handler
 * outcome to HTTP response per the spec's request-bound ack/nack contract.
 */

import type { IdempotencyStore } from "./idempotency-store.js";
import type { IngressQueue, QueueItem } from "./ingress-queue.js";

export type VerifyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 401 | 403;
      readonly message: string;
    };

export type WebhookIngressOptions<P, N> = {
  readonly request: Request;
  readonly verify: (request: Request) => Promise<VerifyResult>;
  readonly extractKey: (parsed: P) => string;
  readonly parsePayload: (
    request: Request,
  ) => Promise<{ readonly payload: P; readonly normalized: N }>;
  readonly idempotencyStore: IdempotencyStore;
  readonly ingressQueue: IngressQueue<P, N>;
  readonly leaseMs: number;
  readonly inFlightWaitMs: number;
  readonly handshakeResponse?: () => Promise<Response | null>;
};

export async function handleWebhookIngress<P, N>(
  o: WebhookIngressOptions<P, N>,
): Promise<Response> {
  if (o.handshakeResponse) {
    const handshake = await o.handshakeResponse();
    if (handshake) return handshake;
  }

  const v = await o.verify(o.request);
  if (!v.ok) return new Response(v.message, { status: v.status });

  // `let` justified: parsed must be initialized inside try/catch.
  let parsed: { readonly payload: P; readonly normalized: N };
  try {
    parsed = await o.parsePayload(o.request);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "bad payload";
    return new Response(msg, { status: 400 });
  }
  const key = o.extractKey(parsed.payload);

  const begin = await beginOrResolve(o, key);
  if (begin.kind === "response") return begin.response;

  const item: QueueItem<P, N> = {
    key,
    payload: parsed.payload,
    normalized: parsed.normalized,
  };
  await o.ingressQueue.enqueue(key, item);
  await o.idempotencyStore.abort(begin.lease);
  return new Response(null, { status: 200 });
}

type BeginResolution =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "ok"; readonly lease: import("./idempotency-store.js").Lease };

async function beginOrResolve<P, N>(
  o: WebhookIngressOptions<P, N>,
  key: string,
): Promise<BeginResolution> {
  const begin = await o.idempotencyStore.tryBegin(key, o.leaseMs);
  if (begin.ok) return { kind: "ok", lease: begin.lease };
  if (begin.reason === "committed") return ok200();
  if (begin.reason === "capacity-exhausted") return resp("capacity", 503);
  if (begin.reason === "in-flight") {
    const t0 = Date.now();
    while (Date.now() - t0 < o.inFlightWaitMs) {
      await sleep(5);
      const r2 = await o.idempotencyStore.tryBegin(key, o.leaseMs);
      if (!r2.ok && r2.reason === "committed") return ok200();
      if (r2.ok) {
        await o.idempotencyStore.abort(r2.lease);
        break;
      }
    }
    return resp("in-flight", 503);
  }
  return resp("unknown", 500);
}

function ok200(): BeginResolution {
  return { kind: "response", response: new Response(null, { status: 200 }) };
}

function resp(body: string, status: number): BeginResolution {
  return { kind: "response", response: new Response(body, { status }) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
