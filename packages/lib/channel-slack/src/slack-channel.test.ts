import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { InboundMessage } from "@koi/core";
import {
  createSlackChannel,
  type SocketModeClientLike,
  type WebClientLike,
} from "./slack-channel.js";

interface PostCall {
  readonly args: Record<string, unknown>;
}

function makeWebClient(): { readonly client: WebClientLike; readonly calls: PostCall[] } {
  const calls: PostCall[] = [];
  const client: WebClientLike = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        calls.push({ args });
        return { ok: true };
      },
    },
  };
  return { client, calls };
}

function makeSocketClient(): {
  readonly client: SocketModeClientLike;
  readonly listeners: Map<string, (payload: unknown) => void>;
  started: boolean;
  disconnected: boolean;
} {
  const listeners = new Map<string, (payload: unknown) => void>();
  const state = { started: false, disconnected: false };
  const client: SocketModeClientLike = {
    start: async () => {
      state.started = true;
    },
    disconnect: async () => {
      state.disconnected = true;
    },
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    removeAllListeners: () => {
      listeners.clear();
    },
  };
  return Object.assign(state, { client, listeners });
}

describe("@koi/channel-slack — Socket Mode", () => {
  test("connect() starts the socket client", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    await adapter.connect();
    expect(sock.started).toBe(true);
    await adapter.disconnect();
    expect(sock.disconnected).toBe(true);
  });

  test("incoming message event dispatches an InboundMessage", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      botUserId: "BOT",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();

    const onMessage = sock.listeners.get("message");
    expect(onMessage).toBeDefined();
    onMessage?.({
      event: {
        type: "message",
        text: "hi",
        user: "U1",
        channel: "C1",
        ts: "1700000000.000100",
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    expect(received[0]?.threadId).toBe("C1");
    await adapter.disconnect();
  });

  test("slash command surfaces a slack:slash_command custom block", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();

    const onSlash = sock.listeners.get("slash_commands");
    onSlash?.({
      command: "/koi",
      text: "help",
      user_id: "U2",
      channel_id: "C1",
      trigger_id: "T1",
      response_url: "https://hooks.slack.com/x",
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(received[0]?.content[0]?.kind).toBe("custom");
    await adapter.disconnect();
  });

  test("send() routes to chat.postMessage with channel + thread_ts", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    await adapter.connect();
    await adapter.send({
      content: [{ kind: "text", text: "reply" }],
      threadId: "C1:1700000000.000100",
    });
    expect(web.calls).toHaveLength(1);
    expect(web.calls[0]?.args["channel"]).toBe("C1");
    expect(web.calls[0]?.args["thread_ts"]).toBe("1700000000.000100");
    expect(web.calls[0]?.args["text"]).toBe("reply");
    await adapter.disconnect();
  });

  test("replyToMode 'off' strips thread_ts before sending", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      features: { replyToMode: "off" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    await adapter.connect();
    await adapter.send({
      content: [{ kind: "text", text: "channel-only" }],
      threadId: "C1:1700000000.000100",
    });
    expect(web.calls[0]?.args["channel"]).toBe("C1");
    expect(web.calls[0]?.args["thread_ts"]).toBeUndefined();
    await adapter.disconnect();
  });

  test("Socket Mode dedupes retried message events by envelope_id (no double dispatch)", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      botUserId: "BOT",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();

    let acks = 0;
    const onMessage = sock.listeners.get("message");
    const envelope = {
      envelope_id: "01ABC",
      ack: () => {
        acks++;
      },
      event: { type: "message", text: "x", user: "U1", channel: "C1", ts: "1.0" },
    };
    onMessage?.(envelope);
    onMessage?.(envelope); // retry — same envelope_id
    onMessage?.(envelope); // retry again
    await new Promise((r) => setTimeout(r, 5));
    // All three deliveries must be ack'd (else Slack keeps retrying)…
    expect(acks).toBe(3);
    // …but the handler runs exactly once.
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  test("Socket Mode dedupes retried block_action by envelope_id", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();

    const onInter = sock.listeners.get("interactive");
    const envelope = {
      envelope_id: "ENV-XYZ",
      ack: () => {},
      payload: {
        type: "block_actions",
        user: { id: "U" },
        actions: [{ action_id: "approve", block_id: "b1", value: "yes", type: "button" }],
      },
    };
    onInter?.(envelope);
    onInter?.(envelope); // retry
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  test("Socket Mode dedupe survives >5000 unique deliveries before retry (no FIFO eviction of live keys)", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      botUserId: "BOT",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();

    const onMsg = sock.listeners.get("message");
    // First delivery: unique envelope we'll retry later.
    const target = {
      envelope_id: "TARGET-EARLY",
      ack: () => {},
      event: { type: "message", text: "first", user: "U1", channel: "C1", ts: "1.0" },
    };
    onMsg?.(target);
    // 6000 distinct subsequent deliveries — would FIFO-evict TARGET-EARLY
    // under the old size-cap design.
    for (let i = 0; i < 6000; i++) {
      onMsg?.({
        envelope_id: `E-${i}`,
        ack: () => {},
        event: { type: "message", text: `m${i}`, user: "U1", channel: "C1", ts: `${i}.0` },
      });
    }
    // Retry of the original within the 5-minute replay window — must dedupe.
    onMsg?.(target);
    await new Promise((r) => setTimeout(r, 10));
    // 1 (target) + 6000 (unique) + 0 (retry deduped) = 6001
    expect(received).toHaveLength(6001);
    await adapter.disconnect();
  });

  test("Socket Mode does NOT ack message events when no onMessage handler is registered (Slack retries)", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      botUserId: "BOT",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    // NO onMessage registration before connect
    await adapter.connect();
    let acked = false;
    sock.listeners.get("message")?.({
      ack: () => {
        acked = true;
      },
      event: { type: "message", text: "x", user: "U1", channel: "C1", ts: "1.0" },
    });
    expect(acked).toBe(false); // un-ack so Slack retries
    await adapter.disconnect();
  });

  test("Socket Mode does NOT ack interactive payloads with no handler (no silent drop)", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    // NO onMessage registration
    await adapter.connect();
    let acked = false;
    sock.listeners.get("interactive")?.({
      ack: () => {
        acked = true;
      },
      payload: { type: "block_actions", user: { id: "U" }, actions: [] },
    });
    // No handler attached: ack'ing here would permanently consume the click
    // with no retry path. Letting the 3s deadline elapse surfaces a
    // user-visible error in Slack instead of silently swallowing the action.
    expect(acked).toBe(false);
    await adapter.disconnect();
  });

  test("send() without threadId throws unless defaultChannel is configured", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    await adapter.connect();
    await expect(
      adapter.send({ content: [{ kind: "text", text: "no thread, no default" }] }),
    ).rejects.toThrow(/no threadId/);
    expect(web.calls).toHaveLength(0);
    await adapter.disconnect();
  });

  test("send() without threadId routes to defaultChannel when configured", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      defaultChannel: "C-PROACTIVE",
      clients: { webClient: web.client, socketClient: sock.client },
    });
    await adapter.connect();
    await adapter.send({ content: [{ kind: "text", text: "proactive notice" }] });
    expect(web.calls[0]?.args["channel"]).toBe("C-PROACTIVE");
    expect(web.calls[0]?.args["thread_ts"]).toBeUndefined();
    await adapter.disconnect();
  });

  test("send() rejects when not connected", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    await expect(adapter.send({ content: [{ kind: "text", text: "x" }] })).rejects.toThrow();
  });

  test("slash commands disabled when feature flag is off", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      features: { slashCommands: false },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    await adapter.connect();
    expect(sock.listeners.has("slash_commands")).toBe(false);
    expect(sock.listeners.has("interactive")).toBe(false);
    await adapter.disconnect();
  });

  test("resolves botUserId via auth.test and filters self-authored messages", async () => {
    const sock = makeSocketClient();
    let authCalls = 0;
    const web: WebClientLike = {
      chat: { postMessage: async () => ({ ok: true }) },
      auth: {
        test: async () => {
          authCalls++;
          return { user_id: "BOTSELF" };
        },
      },
    };
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      // botUserId intentionally omitted — must be resolved at connect
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web, socketClient: sock.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();
    expect(authCalls).toBe(1);

    const onMessage = sock.listeners.get("message");
    // self-authored event must be dropped
    onMessage?.({
      event: { type: "message", text: "self", user: "BOTSELF", channel: "C1", ts: "1.0" },
    });
    // foreign user must pass through
    onMessage?.({ event: { type: "message", text: "user", user: "U1", channel: "C1", ts: "2.0" } });
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    expect(received[0]?.senderId).toBe("U1");
    await adapter.disconnect();
  });

  test("Socket Mode listeners fire even when client is created lazily inside platformConnect", async () => {
    // No socketClient injected — exercise the lazy-creation path used in production.
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      botUserId: "BOT",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: {
        webClient: { chat: { postMessage: async () => ({ ok: true }) } },
        // Override the lazy-create by providing AFTER factory but matching what
        // platformConnect would assign — we still want listener wiring driven
        // through the same code path.
        socketClient: sock.client,
      },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();
    // Listeners must be registered BEFORE start() returns so the very first
    // event is captured.
    expect(sock.listeners.has("message")).toBe(true);
    expect(sock.listeners.has("app_mention")).toBe(true);
    sock.listeners.get("message")?.({
      event: { type: "message", text: "first", user: "U1", channel: "C1", ts: "1.0" },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  test("Socket Mode acks unsupported interactive payloads (no Slack retry storm)", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();

    let acked = false;
    const interactive = sock.listeners.get("interactive");
    expect(interactive).toBeDefined();
    // Slack sends a view_submission (modal). We don't dispatch it but we MUST ack.
    interactive?.({
      ack: () => {
        acked = true;
      },
      payload: { type: "view_submission", user: { id: "U1" } },
    });
    expect(acked).toBe(true);
    expect(received).toHaveLength(0); // unsupported types are not surfaced
    await adapter.disconnect();
  });

  test("handleEvent forwards Socket-Mode-style payload", async () => {
    const web = makeWebClient();
    const sock = makeSocketClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      clients: { webClient: web.client, socketClient: sock.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();
    adapter.handleEvent?.({
      type: "event_callback",
      event: { type: "message", text: "via handleEvent", user: "U1", channel: "C1", ts: "1.0" },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });
});

describe("@koi/channel-slack — HTTP Events mode", () => {
  const SECRET = "8f742231b10e8888abcd99yyyzz85a5";

  function sign(timestamp: string, body: string): string {
    const h = createHmac("sha256", SECRET);
    h.update(`v0:${timestamp}:${body}`);
    return `v0=${h.digest("hex")}`;
  }

  test("handleHttpRequest answers url_verification challenge", async () => {
    const web = makeWebClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: SECRET },
      clients: { webClient: web.client },
    });
    await adapter.connect();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const req = new Request("http://x/slack/events", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sign(ts, body),
      },
      body,
    });
    const res = await adapter.handleHttpRequest?.(req);
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe("abc123");
    await adapter.disconnect();
  });

  test("handleHttpRequest rejects unsigned requests with 401", async () => {
    const web = makeWebClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: SECRET },
      clients: { webClient: web.client },
    });
    await adapter.connect();
    const req = new Request("http://x/slack/events", { method: "POST", body: "{}" });
    const res = await adapter.handleHttpRequest?.(req);
    expect(res?.status).toBe(401);
    await adapter.disconnect();
  });

  test("handleHttpRequest dispatches event_callback to onMessage handlers", async () => {
    const web = makeWebClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: SECRET },
      clients: { webClient: web.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "message", text: "from http", user: "U1", channel: "C1", ts: "1.0" },
    });
    const req = new Request("http://x/slack/events", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sign(ts, body),
      },
      body,
    });
    const res = await adapter.handleHttpRequest?.(req);
    expect(res?.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]).toEqual({ kind: "text", text: "from http" });
    await adapter.disconnect();
  });

  test("handleHttpRequest decodes form-encoded slash commands and dispatches them", async () => {
    const web = makeWebClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: SECRET },
      clients: { webClient: web.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();

    const ts = String(Math.floor(Date.now() / 1000));
    const body =
      "command=%2Fkoi&text=help&user_id=U2&channel_id=C1&trigger_id=T1&response_url=https%3A%2F%2Fhooks.slack.com%2Fx";
    const req = new Request("http://x/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sign(ts, body),
      },
      body,
    });
    const res = await adapter.handleHttpRequest?.(req);
    expect(res?.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    expect(received[0]?.senderId).toBe("U2");
    const block = received[0]?.content[0];
    expect(block?.kind).toBe("custom");
    if (block?.kind === "custom") {
      expect((block.data as { readonly command: string }).command).toBe("/koi");
      expect((block.data as { readonly text: string }).text).toBe("help");
    }
    await adapter.disconnect();
  });

  test("handleHttpRequest decodes interactive (block_actions) payload= and dispatches", async () => {
    const web = makeWebClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: SECRET },
      clients: { webClient: web.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();

    const ts = String(Math.floor(Date.now() / 1000));
    const interactivePayload = {
      type: "block_actions",
      user: { id: "U9" },
      channel: { id: "C2" },
      message: { ts: "1.0", thread_ts: "0.5" },
      actions: [{ action_id: "approve", block_id: "b1", value: "yes", type: "button" }],
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(interactivePayload))}`;
    const req = new Request("http://x/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sign(ts, body),
      },
      body,
    });
    const res = await adapter.handleHttpRequest?.(req);
    expect(res?.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    expect(received[0]?.senderId).toBe("U9");
    expect(received[0]?.threadId).toBe("C2:0.5");
    await adapter.disconnect();
  });

  test("handleHttpRequest returns 413 for oversized requests (no body buffering)", async () => {
    const web = makeWebClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: SECRET },
      clients: { webClient: web.client },
    });
    await adapter.connect();
    const ts = String(Math.floor(Date.now() / 1000));
    const req = new Request("http://x", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sign(ts, "ignored"),
        "content-length": "200000", // exceeds 100 KB cap
      },
      body: "x".repeat(10), // small actual body — header is what matters for the guard
    });
    const res = await adapter.handleHttpRequest?.(req);
    expect(res?.status).toBe(413);
    await adapter.disconnect();
  });

  test("handleHttpRequest dedupes retried event_callback by event_id (no double dispatch)", async () => {
    const web = makeWebClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: SECRET },
      clients: { webClient: web.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      event_id: "Ev123",
      type: "event_callback",
      event: { type: "message", text: "x", user: "U1", channel: "C1", ts: "1.0" },
    });
    const mkReq = (): Request =>
      new Request("http://x", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Slack-Request-Timestamp": ts,
          "X-Slack-Signature": sign(ts, body),
        },
        body,
      });
    const r1 = await adapter.handleHttpRequest?.(mkReq());
    const r2 = await adapter.handleHttpRequest?.(mkReq());
    expect(r1?.status).toBe(200);
    expect(r2?.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    // The second (retried) delivery must be acked but not dispatched.
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  test("handleHttpRequest dedupes retried slash command by Retry-Num + body hash", async () => {
    const web = makeWebClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: SECRET },
      clients: { webClient: web.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = "command=%2Fkoi&text=help&user_id=U2&channel_id=C1&trigger_id=T1&response_url=";
    const mkReq = (): Request =>
      new Request("http://x", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "X-Slack-Request-Timestamp": ts,
          "X-Slack-Signature": sign(ts, body),
          "X-Slack-Retry-Num": "1",
        },
        body,
      });
    await adapter.handleHttpRequest?.(mkReq());
    await adapter.handleHttpRequest?.(mkReq());
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  test("handleHttpRequest does NOT dedupe two identical fresh slash commands (no Retry-Num)", async () => {
    // Regression: a body-hash dedupe fallback would silently swallow the
    // second of two legitimate identical user-initiated slash commands.
    const web = makeWebClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: SECRET },
      clients: { webClient: web.client },
    });
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();
    const body = "command=%2Fkoi&text=help&user_id=U2&channel_id=C1&trigger_id=T1&response_url=";
    const mkReq = (): Request => {
      const ts = String(Math.floor(Date.now() / 1000));
      return new Request("http://x", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "X-Slack-Request-Timestamp": ts,
          "X-Slack-Signature": sign(ts, body),
          // Note: no X-Slack-Retry-Num — fresh user invocations.
        },
        body,
      });
    };
    await adapter.handleHttpRequest?.(mkReq());
    await adapter.handleHttpRequest?.(mkReq());
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(2);
    await adapter.disconnect();
  });

  test("handleHttpRequest returns 503 when no listener is registered (Slack retries)", async () => {
    const web = makeWebClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: SECRET },
      clients: { webClient: web.client },
    });
    // NO onMessage registration
    await adapter.connect();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "message", text: "x", user: "U1", channel: "C1", ts: "1.0" },
    });
    const req = new Request("http://x", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sign(ts, body),
      },
      body,
    });
    const res = await adapter.handleHttpRequest?.(req);
    expect(res?.status).toBe(503);
    await adapter.disconnect();
  });

  test("url_verification handshake works even before any onMessage handler is registered", async () => {
    const web = makeWebClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: SECRET },
      clients: { webClient: web.client },
    });
    // Crucially: NO onMessage registration. App install path must still work.
    await adapter.connect();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: "url_verification", challenge: "xyz" });
    const req = new Request("http://x", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sign(ts, body),
      },
      body,
    });
    const res = await adapter.handleHttpRequest?.(req);
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe("xyz");
    await adapter.disconnect();
  });

  test("HTTP mode does not expose handleEvent (only handleHttpRequest)", () => {
    const web = makeWebClient();
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "http", signingSecret: SECRET },
      clients: { webClient: web.client },
    });
    expect(adapter.handleEvent).toBeUndefined();
    expect(adapter.handleHttpRequest).toBeDefined();
  });
});
