import { describe, expect, test } from "bun:test";
import { InMemoryIdempotencyStore, InMemoryIngressQueue, markDurable } from "@koi/channel-base";
import type { InboundMessage } from "@koi/core";
import type { WhatsAppConfig } from "./config.js";
import type { WhatsAppMessage } from "./normalize.js";
import type { FetchFn } from "./platform-send.js";
import { createWhatsAppChannel, type WhatsAppDependencies } from "./whatsapp-channel.js";

const config: WhatsAppConfig = {
  phoneNumberId: "pn-1",
  accessToken: "tok",
  verifyToken: "verify-secret",
  appSecret: "app-secret",
  graphBaseUrl: "https://graph.facebook.com/v18.0",
  production: false,
  handlerTimeoutMs: 1_000,
  commitTtlMs: 86_400_000,
};

function buildDeps(fetchFn?: FetchFn): WhatsAppDependencies {
  return {
    fetch: fetchFn ?? (async () => new Response("{}", { status: 200 })),
    idempotencyStore: new InMemoryIdempotencyStore(),
    ingressQueue: new InMemoryIngressQueue<WhatsAppMessage, InboundMessage>(),
  };
}

function signBody(body: string, secret: string = config.appSecret): string {
  const h = new Bun.CryptoHasher("sha256", secret);
  h.update(body);
  return `sha256=${h.digest("hex")}`;
}

function makeWebhookBody(overrides: Partial<WhatsAppMessage> = {}): string {
  const message: WhatsAppMessage = {
    id: "wamid.ABC",
    from: "15551234567",
    timestamp: "1700000000",
    type: "text",
    text: { body: "hello" },
    ...overrides,
  };
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "biz-1",
        changes: [
          {
            value: {
              metadata: { phone_number_id: config.phoneNumberId },
              messages: [message],
            },
            field: "messages",
          },
        ],
      },
    ],
  });
}

function makePostRequest(body: string, sig?: string): Request {
  return new Request("https://localhost/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sig ?? signBody(body),
    },
    body,
  });
}

describe("createWhatsAppChannel", () => {
  test("returns ChannelAdapter with handleHttpRequest", () => {
    const ch = createWhatsAppChannel(config, buildDeps());
    expect(ch.name).toBe("whatsapp");
    expect(typeof ch.handleHttpRequest).toBe("function");
    expect(ch.capabilities.text).toBe(true);
  });

  test("GET handshake returns hub.challenge on matching verify_token", async () => {
    const ch = createWhatsAppChannel(config, buildDeps());
    const url =
      "https://localhost/webhook?hub.mode=subscribe" +
      `&hub.verify_token=${encodeURIComponent(config.verifyToken)}` +
      "&hub.challenge=42";
    const r = await ch.handleHttpRequest(new Request(url, { method: "GET" }));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("42");
  });

  test("GET handshake returns 403 on bad verify_token", async () => {
    const ch = createWhatsAppChannel(config, buildDeps());
    const url =
      "https://localhost/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42";
    const r = await ch.handleHttpRequest(new Request(url, { method: "GET" }));
    expect(r.status).toBe(403);
  });

  test("POST with valid signature enqueues and dispatches", async () => {
    const ch = createWhatsAppChannel(config, buildDeps());
    const seen: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      seen.push(m);
    });
    await ch.connect();

    const body = makeWebhookBody();
    const r = await ch.handleHttpRequest(makePostRequest(body));
    expect(r.status).toBe(200);

    await new Promise((res) => setTimeout(res, 400));
    await ch.disconnect();
    expect(seen.length).toBe(1);
    expect(seen[0]?.senderId).toBe("15551234567");
    expect(seen[0]?.metadata?.wamid).toBe("wamid.ABC");
  });

  test("POST with mutated body returns 401", async () => {
    const ch = createWhatsAppChannel(config, buildDeps());
    const original = makeWebhookBody();
    const sig = signBody(original);
    const tamperedRequest = new Request("https://localhost/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
      },
      body: makeWebhookBody({ text: { body: "TAMPERED" } }),
    });
    const r = await ch.handleHttpRequest(tamperedRequest);
    expect(r.status).toBe(401);
  });

  test("duplicate WAMID only dispatches once", async () => {
    const ch = createWhatsAppChannel(config, buildDeps());
    const seen: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      seen.push(m);
    });
    await ch.connect();

    const body = makeWebhookBody();
    const r1 = await ch.handleHttpRequest(makePostRequest(body));
    expect(r1.status).toBe(200);
    await new Promise((res) => setTimeout(res, 200));
    const r2 = await ch.handleHttpRequest(makePostRequest(body));
    expect(r2.status).toBe(200);
    await new Promise((res) => setTimeout(res, 400));
    await ch.disconnect();
    expect(seen.length).toBe(1);
  });

  test("mixed-validity batch enqueues valid sibling and reports issues for invalid entries", async () => {
    // Regression: previously a single malformed/mismatched entry 400'd
    // the entire webhook and Meta-no-retry-on-4xx silently dropped the
    // valid siblings. Now valid entries are enqueued, invalid ones
    // surface via onIngressIssue, and the response is 200.
    const issues: unknown[] = [];
    const deps = buildDeps();
    const seen: InboundMessage[] = [];
    const validMsg: WhatsAppMessage = {
      id: "wamid.VALID",
      from: "15551111111",
      timestamp: "1700000000",
      type: "text",
      text: { body: "ok" },
    };
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "biz-1",
          changes: [
            {
              value: {
                metadata: { phone_number_id: config.phoneNumberId },
                messages: [
                  validMsg,
                  // Structurally malformed: missing id/type → reported
                  // as malformed-entry by extractMessages.
                  { from: "x", timestamp: "1" },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    });
    const ch = createWhatsAppChannel(config, {
      ...deps,
      onIngressIssue: (issue) => issues.push(issue),
    });
    ch.onMessage(async (m) => {
      seen.push(m);
    });
    await ch.connect();
    const res = await ch.handleHttpRequest(makePostRequest(body));
    await new Promise((r) => setTimeout(r, 350));
    await ch.disconnect();
    expect(res.status).toBe(200);
    expect(seen.length).toBe(1);
    expect(seen[0]?.threadId).toContain("15551111111");
    expect(issues).toEqual([{ kind: "malformed-entry", count: 1 }]);
  });

  test("messages[] without metadata.phone_number_id → 200 + all-invalid-batch issue with raw body", async () => {
    // Regression: when a message-bearing webhook arrived with a valid
    // entry but no `metadata.phone_number_id`, the previous code
    // silently 200-acked and dropped every contained message. We now
    // count each missing-pid message as malformed and surface the raw
    // body via onIngressIssue(all-invalid-batch) so operators can
    // persist for replay. Response stays 200 because Meta does not
    // retry 4xx — a 400 would permanently drop every contained user
    // message; the operator's issue feed IS the dead-letter surface.
    const issues: unknown[] = [];
    const deps: WhatsAppDependencies = {
      ...buildDeps(),
      onIngressIssue: (i) => issues.push(i),
    };
    const ch = createWhatsAppChannel(config, deps);
    await ch.connect();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "biz-1",
          changes: [
            {
              value: {
                metadata: {},
                messages: [
                  {
                    id: "wamid.NOPID",
                    from: "15551234567",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "hello" },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    });
    const res = await ch.handleHttpRequest(makePostRequest(body));
    expect(res.status).toBe(200);
    expect(issues).toEqual([
      { kind: "malformed-entry", count: 1 },
      { kind: "all-invalid-batch", rawBody: body, malformedCount: 1 },
    ]);
    await ch.disconnect();
  });

  test("envelope-shape drift: 200 + onIngressIssue with raw body (no permanent loss)", async () => {
    // Regression: a missing `entry` array (Meta schema regression,
    // proxy truncation) used to either silently 200-ack with no
    // signal OR (after round-23) 400 — both lose the message
    // because Meta does not retry 4xx. Now: 200-ack so Meta stops
    // retrying AND surface the raw body via onIngressIssue so the
    // operator's hook can persist it for replay (production
    // requires the hook).
    const issues: unknown[] = [];
    const deps: WhatsAppDependencies = {
      ...buildDeps(),
      onIngressIssue: (i) => issues.push(i),
    };
    const ch = createWhatsAppChannel(config, deps);
    await ch.connect();
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    const res = await ch.handleHttpRequest(makePostRequest(body));
    expect(res.status).toBe(200);
    expect(issues).toEqual([{ kind: "envelope-unrecognized", rawBody: body }]);
    await ch.disconnect();
  });

  test("production mode requires onIngressIssue hook", async () => {
    // Regression: all-invalid webhook batches 200-ack with no native
    // retry surface. The ingress-issue hook is the operator's only
    // dead-letter signal in that case; the factory must refuse to
    // start in production without it.
    //
    // Wrap the in-memory stores in plain objects so the durability
    // guard doesn't fire first — we want to assert the missing-hook
    // branch.
    const idem = new InMemoryIdempotencyStore();
    const queue = new InMemoryIngressQueue<WhatsAppMessage, InboundMessage>();
    const durableLikeIdem = markDurable({
      tryBegin: idem.tryBegin.bind(idem),
      commit: idem.commit.bind(idem),
      commitPoison: idem.commitPoison.bind(idem),
      abort: idem.abort.bind(idem),
      renew: idem.renew.bind(idem),
    });
    const durableLikeQueue = markDurable({
      enqueue: queue.enqueue.bind(queue),
      claim: queue.claim.bind(queue),
      ack: queue.ack.bind(queue),
      nack: queue.nack.bind(queue),
      deadLetter: queue.deadLetter.bind(queue),
      renew: queue.renew.bind(queue),
      awaitDrain: queue.awaitDrain.bind(queue),
      getDeadLetters: queue.getDeadLetters.bind(queue),
    });
    const prodConfig: WhatsAppConfig = { ...config, production: true };
    const prodDeps: WhatsAppDependencies = {
      fetch: async () => new Response("{}", { status: 200 }),
      idempotencyStore: durableLikeIdem,
      ingressQueue: durableLikeQueue,
    };
    expect(() => createWhatsAppChannel(prodConfig, prodDeps)).toThrow(
      /MISSING_PRODUCTION_DEPENDENCY/,
    );
  });

  test("POST before connect() returns 503 (worker not running)", async () => {
    // Regression: previously the webhook accepted and 200-acked POSTs
    // regardless of channel state. Meta treats 200 as processed and
    // does not retry, so any inbound landing before connect() / after
    // disconnect() was silent message loss. Now the handler fails
    // closed with 503 (retryable on Meta's side) until the worker is
    // live.
    const ch = createWhatsAppChannel(config, buildDeps());
    const res = await ch.handleHttpRequest(makePostRequest(makeWebhookBody()));
    expect(res.status).toBe(503);
  });

  test("POST after disconnect() returns 503", async () => {
    const ch = createWhatsAppChannel(config, buildDeps());
    await ch.connect();
    await ch.disconnect();
    const res = await ch.handleHttpRequest(makePostRequest(makeWebhookBody()));
    expect(res.status).toBe(503);
  });

  test("GET handshake works before connect() (no worker required)", async () => {
    // GET is verification-only and answers from config — should
    // remain available pre-connect so Meta's initial handshake
    // succeeds before the channel is brought up.
    const ch = createWhatsAppChannel(config, buildDeps());
    const url =
      "https://localhost/webhook?hub.mode=subscribe" +
      `&hub.verify_token=${encodeURIComponent(config.verifyToken)}` +
      "&hub.challenge=42";
    const r = await ch.handleHttpRequest(new Request(url, { method: "GET" }));
    expect(r.status).toBe(200);
  });

  test("send() with non-text block throws UNSUPPORTED_BLOCK", async () => {
    // Regression: previously send() silently dropped non-text blocks
    // and posted a (possibly empty) text payload to Graph. Capability
    // flags advertise text-only; sending a non-text block must fail
    // closed at the channel boundary so the caller learns immediately.
    const ch = createWhatsAppChannel(config, buildDeps());
    let err: unknown = null;
    try {
      await ch.send({
        threadId: "15551234567",
        content: [
          { kind: "text", text: "hi" },
          { kind: "image", url: "https://x/y.png" },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("UNSUPPORTED_BLOCK");
  });

  test("send() without threadId throws INVALID_PAYLOAD", async () => {
    const ch = createWhatsAppChannel(config, buildDeps());
    let err: unknown = null;
    try {
      await ch.send({ content: [{ kind: "text", text: "hi" }] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("INVALID_PAYLOAD");
  });
});
