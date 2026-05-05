import { describe, expect, test } from "bun:test";
import { InMemoryIdempotencyStore } from "./idempotency-store.js";
import { InMemoryIngressQueue } from "./ingress-queue.js";
import { handleWebhookIngress } from "./webhook-handler.js";

const setup = (): {
  idem: InMemoryIdempotencyStore;
  queue: InMemoryIngressQueue;
} => ({
  idem: new InMemoryIdempotencyStore(),
  queue: new InMemoryIngressQueue(),
});

describe("handleWebhookIngress", () => {
  test("auth fail returns 401", async () => {
    const { idem, queue } = setup();
    const res = await handleWebhookIngress({
      request: new Request("http://x/x", { method: "POST" }),
      verify: async () => ({ ok: false, status: 401, message: "bad sig" }),
      extractKey: () => "k",
      parsePayload: async () => ({ payload: {}, normalized: null }),
      idempotencyStore: idem,
      ingressQueue: queue,
      leaseMs: 1000,
      inFlightWaitMs: 1,
    });
    expect(res.status).toBe(401);
  });

  test("happy path: enqueue + 200", async () => {
    const { idem, queue } = setup();
    const res = await handleWebhookIngress({
      request: new Request("http://x/x", { method: "POST" }),
      verify: async () => ({ ok: true }),
      extractKey: () => "k1",
      parsePayload: async () => ({ payload: { x: 1 }, normalized: { y: 2 } }),
      idempotencyStore: idem,
      ingressQueue: queue,
      leaseMs: 1000,
      inFlightWaitMs: 1,
    });
    expect(res.status).toBe(200);
    const c = await queue.claim("w1", 100);
    expect(c?.key).toBe("k1");
  });

  test("committed key returns 200 silently", async () => {
    const { idem, queue } = setup();
    const r = await idem.tryBegin("k1", 100);
    if (!r.ok) throw new Error();
    await idem.commit(r.lease, 1000);
    const res = await handleWebhookIngress({
      request: new Request("http://x/x", { method: "POST" }),
      verify: async () => ({ ok: true }),
      extractKey: () => "k1",
      parsePayload: async () => ({ payload: {}, normalized: null }),
      idempotencyStore: idem,
      ingressQueue: queue,
      leaseMs: 1000,
      inFlightWaitMs: 1,
    });
    expect(res.status).toBe(200);
  });

  test("in-flight returns 503 after wait", async () => {
    const { idem, queue } = setup();
    const r = await idem.tryBegin("k1", 1000);
    if (!r.ok) throw new Error();
    const res = await handleWebhookIngress({
      request: new Request("http://x/x", { method: "POST" }),
      verify: async () => ({ ok: true }),
      extractKey: () => "k1",
      parsePayload: async () => ({ payload: {}, normalized: null }),
      idempotencyStore: idem,
      ingressQueue: queue,
      leaseMs: 100,
      inFlightWaitMs: 5,
    });
    expect(res.status).toBe(503);
  });

  test("parse failure returns 400", async () => {
    const { idem, queue } = setup();
    const res = await handleWebhookIngress({
      request: new Request("http://x/x", { method: "POST" }),
      verify: async () => ({ ok: true }),
      extractKey: () => "k1",
      parsePayload: async () => {
        throw new Error("bad json");
      },
      idempotencyStore: idem,
      ingressQueue: queue,
      leaseMs: 1000,
      inFlightWaitMs: 1,
    });
    expect(res.status).toBe(400);
  });

  test("handshake response short-circuits", async () => {
    const { idem, queue } = setup();
    const res = await handleWebhookIngress({
      request: new Request("http://x/x?hub.challenge=abc", { method: "GET" }),
      verify: async () => ({ ok: true }),
      extractKey: () => "k1",
      parsePayload: async () => ({ payload: {}, normalized: null }),
      idempotencyStore: idem,
      ingressQueue: queue,
      leaseMs: 1000,
      inFlightWaitMs: 1,
      handshakeResponse: async () => new Response("abc", { status: 200 }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc");
    // No enqueue happened.
    expect(await queue.claim("w1", 100)).toBeNull();
  });

  test("capacity exhausted returns 503", async () => {
    const idem = new InMemoryIdempotencyStore({ maxCommittedRecords: 1 });
    const queue = new InMemoryIngressQueue();
    const r = await idem.tryBegin("k0", 100);
    if (!r.ok) throw new Error();
    await idem.commit(r.lease, 10_000);
    const res = await handleWebhookIngress({
      request: new Request("http://x/x", { method: "POST" }),
      verify: async () => ({ ok: true }),
      extractKey: () => "k1",
      parsePayload: async () => ({ payload: {}, normalized: null }),
      idempotencyStore: idem,
      ingressQueue: queue,
      leaseMs: 1000,
      inFlightWaitMs: 1,
    });
    expect(res.status).toBe(503);
  });
});
