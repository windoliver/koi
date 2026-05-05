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

  const begin = await o.idempotencyStore.tryBegin(key, o.leaseMs);
  if (!begin.ok && begin.reason === "committed") {
    return new Response(null, { status: 200 });
  }
  if (!begin.ok && begin.reason === "in-flight") {
    const t0 = Date.now();
    while (Date.now() - t0 < o.inFlightWaitMs) {
      await sleep(5);
      const r2 = await o.idempotencyStore.tryBegin(key, o.leaseMs);
      if (!r2.ok && r2.reason === "committed") {
        return new Response(null, { status: 200 });
      }
      if (r2.ok) {
        await o.idempotencyStore.abort(r2.lease);
        break;
      }
    }
    return new Response("in-flight", { status: 503 });
  }
  if (!begin.ok && begin.reason === "capacity-exhausted") {
    return new Response("capacity", { status: 503 });
  }
  if (!begin.ok) return new Response("unknown", { status: 500 });

  // ok: enqueue then release lease (the worker will re-claim).
  const item: QueueItem<P, N> = {
    key,
    payload: parsed.payload,
    normalized: parsed.normalized,
  };
  const enq = await o.ingressQueue.enqueue(key, item);
  await o.idempotencyStore.abort(begin.lease);
  if (!enq.ok && enq.reason === "duplicate") {
    return new Response(null, { status: 200 });
  }
  return new Response(null, { status: 200 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
