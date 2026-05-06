import { describe, expect, test } from "bun:test";
import { InMemoryIdempotencyStore, InMemoryIngressQueue } from "@koi/channel-base";
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
