import { describe, expect, test } from "bun:test";
import {
  InMemoryConversationAddressStore,
  InMemoryIdempotencyStore,
  InMemoryIngressQueue,
} from "@koi/channel-base";
import type { InboundMessage } from "@koi/core";
import type { TeamsConfig } from "../config.js";
import type { Activity } from "../normalize.js";
import type { FetchFn } from "../platform-send.js";
import { createTeamsChannel } from "../teams-channel.js";
import type { JwtVerifier, VerifyResult } from "../verify-jwt.js";

const config: TeamsConfig = {
  appId: "app-1",
  appPassword: "secret",
  tenantAllowlist: ["tenant-1"],
  cloud: "public",
  serviceUrlAllowlist: [{ scheme: "https", host: "smba.trafficmanager.net", hostMatch: "exact" }],
  production: false,
  handlerTimeoutMs: 1_000,
  commitTtlMs: 86_400_000,
};

const okVerdict: VerifyResult = {
  ok: true,
  claims: {
    aud: "app-1",
    tid: "tenant-1",
    iss: "https://api.botframework.com",
    exp: 9_999_999_999,
    nbf: 0,
  },
};

const fakeVerifier: JwtVerifier = {
  verify: async () => okVerdict,
  appToken: async () => "outbound-bearer",
};

describe("teams-channel integration", () => {
  test("connect → POST inbound → onMessage fires → send() POSTs to verified serviceUrl with bearer", async () => {
    const fetchCalls: { readonly url: string; readonly auth: string; readonly body: string }[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : "";
      fetchCalls.push({ url, auth: headers.get("authorization") ?? "", body });
      return new Response(JSON.stringify({ id: "out-1" }), { status: 200 });
    };

    const channel = createTeamsChannel(config, {
      tokenVerifier: fakeVerifier,
      fetch: fetchFn,
      idempotencyStore: new InMemoryIdempotencyStore(),
      conversationAddressStore: new InMemoryConversationAddressStore(),
      ingressQueue: new InMemoryIngressQueue<Activity, InboundMessage>(),
    });

    const received: InboundMessage[] = [];
    channel.onMessage(async (m) => {
      received.push(m);
    });

    await channel.connect();

    const activity: Activity = {
      type: "message",
      id: "act-1",
      conversation: { id: "conv-1", tenantId: "tenant-1" },
      from: { id: "user-1", name: "Alice" },
      serviceUrl: "https://smba.trafficmanager.net/",
      channelId: "msteams",
      text: "hello bot",
      timestamp: "2026-05-05T12:00:00.000Z",
    };
    const req = new Request("https://localhost/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer xxx" },
      body: JSON.stringify(activity),
    });
    const resp = await channel.handleHttpRequest(req);
    expect(resp.status).toBe(200);

    // wait for worker to drain
    await new Promise((r) => setTimeout(r, 400));
    expect(received.length).toBe(1);
    expect(received[0]?.threadId).toBe("conv-1");

    await channel.send({
      content: [{ kind: "text", text: "ack" }],
      threadId: "conv-1",
    });
    expect(fetchCalls.length).toBe(1);
    const call = fetchCalls[0];
    if (call === undefined) throw new Error("unreachable");
    expect(call.url).toBe("https://smba.trafficmanager.net/v3/conversations/conv-1/activities");
    expect(call.auth).toBe("Bearer outbound-bearer");
    expect(call.body).toContain("ack");

    await channel.disconnect();
  });
});
