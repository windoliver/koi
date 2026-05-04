import type { InboundMessage } from "@koi/core";
import { createSlackChannel } from "../src/index.js";

const SECRET = "test-signing-secret";

const fakeWeb = {
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  chat: { postMessage: async (_args: any) => ({ ok: true, ts: "1.0", channel: "C0" }) },
  auth: { test: async () => ({ ok: true, user_id: "BOTU", bot_id: "B0" }) },
};

const seen: InboundMessage[] = [];

const ch = createSlackChannel({
  botToken: "xoxb-test",
  deployment: { mode: "http", signingSecret: SECRET },
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  clients: { webClient: fakeWeb as any },
});

ch.onMessage(async (m: InboundMessage): Promise<void> => {
  seen.push(m);
});

await ch.connect();

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    if (ch.handleHttpRequest === undefined) return new Response("nohandler", { status: 500 });
    return ch.handleHttpRequest(req);
  },
});

console.log(JSON.stringify({ port: server.port, secret: SECRET }));
await new Promise<void>(() => {});
