import { describe, expect, test } from "bun:test";
import { InMemoryIdempotencyStore, InMemoryIngressQueue } from "@koi/channel-base";
import type { InboundMessage } from "@koi/core";
import type { WhatsAppConfig } from "../config.js";
import type { WhatsAppMessage } from "../normalize.js";
import type { FetchFn } from "../platform-send.js";
import { createWhatsAppChannel } from "../whatsapp-channel.js";

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

function signBody(body: string, secret: string = config.appSecret): string {
  const h = new Bun.CryptoHasher("sha256", secret);
  h.update(body);
  return `sha256=${h.digest("hex")}`;
}

describe("whatsapp-channel integration", () => {
  test("connect → POST inbound → onMessage fires → send() POSTs to Graph API", async () => {
    const fetchCalls: { readonly url: string; readonly auth: string; readonly body: string }[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : "";
      fetchCalls.push({ url, auth: headers.get("authorization") ?? "", body });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 });
    };

    const channel = createWhatsAppChannel(config, {
      fetch: fetchFn,
      idempotencyStore: new InMemoryIdempotencyStore(),
      ingressQueue: new InMemoryIngressQueue<WhatsAppMessage, InboundMessage>(),
    });

    const received: InboundMessage[] = [];
    channel.onMessage(async (m) => {
      received.push(m);
    });

    await channel.connect();

    const message: WhatsAppMessage = {
      id: "wamid.IN1",
      from: "15551234567",
      timestamp: "1700000000",
      type: "text",
      text: { body: "hello bot" },
    };
    const webhook = JSON.stringify({
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
    const req = new Request("https://localhost/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signBody(webhook),
      },
      body: webhook,
    });
    const resp = await channel.handleHttpRequest(req);
    expect(resp.status).toBe(200);

    await new Promise((r) => setTimeout(r, 400));
    expect(received.length).toBe(1);
    expect(received[0]?.threadId).toBe("pn-1|15551234567");

    await channel.send({
      content: [{ kind: "text", text: "ack" }],
      threadId: "pn-1|15551234567",
    });
    expect(fetchCalls.length).toBe(1);
    const call = fetchCalls[0];
    if (call === undefined) throw new Error("unreachable");
    expect(call.url).toBe("https://graph.facebook.com/v18.0/pn-1/messages");
    expect(call.auth).toBe("Bearer tok");
    expect(call.body).toContain("ack");
    expect(call.body).toContain("15551234567");

    await channel.disconnect();
  });
});
