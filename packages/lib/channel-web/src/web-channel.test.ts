import { afterEach, describe, expect, test } from "bun:test";
import type { ChannelAdapter, InboundMessage } from "@koi/core";
import { createWebChannel } from "./web-channel.js";

interface TestHarness {
  readonly adapter: ChannelAdapter;
  readonly port: number;
  readonly received: InboundMessage[];
}

async function startHarness(
  config: Parameters<typeof createWebChannel>[0] = {},
): Promise<TestHarness> {
  // Default to open mode for tests — production callers must set
  // `authenticate` or `allowUnauthenticated` themselves.
  const adapter = createWebChannel({
    port: 0,
    hostname: "127.0.0.1",
    allowUnauthenticated: true,
    // Test harness opt-in: skip the CSRF fail-closed gate. Real consumers
    // pass `originAllowList` (or `allowAnyOrigin: true` if their auth is
    // not browser-ambient).
    allowAnyOrigin: true,
    ...config,
  });
  await adapter.connect();
  const port = (adapter as unknown as { readonly port: number }).port;
  const received: InboundMessage[] = [];
  adapter.onMessage(async (msg) => {
    received.push(msg);
  });
  return { adapter, port, received };
}

describe("@koi/channel-web", () => {
  // let requires justification: harness reassigned per test in beforeEach
  let h: TestHarness;

  afterEach(async () => {
    await h?.adapter.disconnect();
  });

  test("createWebChannel throws when no authenticate and no explicit insecure opt-in", () => {
    expect(() => createWebChannel({ port: 0 })).toThrow(/no authentication configured/);
  });

  test("createWebChannel constructs cleanly when authenticate is provided", () => {
    expect(() =>
      createWebChannel({
        port: 0,
        authenticate: () => ({ senderId: "u" }),
        originAllowList: ["https://app.example"],
      }),
    ).not.toThrow();
  });

  test("createWebChannel throws when authenticate is set without originAllowList (CSRF gate)", () => {
    expect(() => createWebChannel({ port: 0, authenticate: () => ({ senderId: "u" }) })).toThrow(
      /originAllowList/,
    );
  });

  test("createWebChannel allows authenticate with no allowList when allowAnyOrigin is opted in", () => {
    expect(() =>
      createWebChannel({
        port: 0,
        authenticate: () => ({ senderId: "u" }),
        allowAnyOrigin: true,
      }),
    ).not.toThrow();
  });

  test("POST /messages returns 503 when no handler is registered (no silent drop)", async () => {
    const adapter = createWebChannel({
      port: 0,
      hostname: "127.0.0.1",
      allowUnauthenticated: true,
    });
    await adapter.connect();
    const port = (adapter as unknown as { readonly port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [{ kind: "text", text: "x" }] }),
    });
    expect(res.status).toBe(503);
    await adapter.disconnect();
  });

  test("declares correct capabilities", async () => {
    h = await startHarness();
    expect(h.adapter.capabilities).toEqual({
      text: true,
      images: true,
      files: true,
      buttons: true,
      audio: false,
      video: false,
      threads: true,
      supportsA2ui: false,
    });
  });

  test("connect() then disconnect() is idempotent", async () => {
    h = await startHarness();
    await h.adapter.connect(); // second connect — no-op
    await h.adapter.disconnect();
    await h.adapter.disconnect(); // second disconnect — no-op
    // re-create to satisfy afterEach
    h = await startHarness();
  });

  test("POST /messages dispatches an InboundMessage with auth-derived senderId", async () => {
    h = await startHarness({ authenticate: () => ({ senderId: "alice" }) });
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: [{ kind: "text", text: "hello" }],
        threadId: "t1",
      }),
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.received).toHaveLength(1);
    expect(h.received[0]?.senderId).toBe("alice");
    expect(h.received[0]?.threadId).toBe("t1");
    expect(h.received[0]?.content).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("POST /messages stamps default senderId in open (no-auth) mode", async () => {
    h = await startHarness({ senderId: "default-user" });
    await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [{ kind: "text", text: "hi" }] }),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.received[0]?.senderId).toBe("default-user");
  });

  test("POST rejects invalid JSON with 400", async () => {
    h = await startHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
  });

  test("POST rejects payload missing content[] with 400", async () => {
    h = await startHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ senderId: "x" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST rejects content blocks with unknown kind synchronously (no async data loss)", async () => {
    h = await startHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [{ oops: 1 }] }),
    });
    expect(res.status).toBe(400);
    expect(h.received).toHaveLength(0);
  });

  test("POST rejects empty content[] with 400", async () => {
    h = await startHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [] }),
    });
    expect(res.status).toBe(400);
  });

  test("POST rejects text block with non-string text field with 400", async () => {
    h = await startHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [{ kind: "text", text: 123 }] }),
    });
    expect(res.status).toBe(400);
  });

  test("POST rejects payload > 1MB with 413", async () => {
    h = await startHarness();
    const huge = "x".repeat(1_100_000);
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        senderId: "a",
        content: [{ kind: "text", text: huge }],
      }),
    });
    expect(res.status).toBe(413);
  });

  test("GET on unknown route returns 404", async () => {
    h = await startHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/nope`);
    expect(res.status).toBe(404);
  });

  test("authenticate rejects missing/invalid bearer with 401", async () => {
    h = await startHarness({
      authenticate: (ctx) => (ctx.token === "secret" ? { senderId: "alice" } : null),
    });
    const r1 = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [{ kind: "text", text: "x" }] }),
    });
    expect(r1.status).toBe(401);

    const r2 = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({ content: [{ kind: "text", text: "x" }], threadId: "t1" }),
    });
    expect(r2.status).toBe(202);
  });

  test("authenticate ignores body senderId — uses verified principal instead (no impersonation)", async () => {
    h = await startHarness({
      authenticate: () => ({ senderId: "verified-alice" }),
    });
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        senderId: "spoofed-bob", // ← attacker tries to impersonate
        content: [{ kind: "text", text: "hello" }],
        threadId: "t1",
      }),
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.received[0]?.senderId).toBe("verified-alice");
  });

  test("authenticate can deny per thread — host enforces tenant isolation", async () => {
    h = await startHarness({
      authenticate: (ctx) => (ctx.threadId === "alice-room" ? { senderId: "alice" } : null),
    });
    const allowed = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "alice-room",
        content: [{ kind: "text", text: "ok" }],
      }),
    });
    expect(allowed.status).toBe(202);

    const denied = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "bob-room",
        content: [{ kind: "text", text: "denied" }],
      }),
    });
    expect(denied.status).toBe(401);
  });

  test("originAllowList denies disallowed origin with 403", async () => {
    h = await startHarness({ originAllowList: ["https://app.example"] });
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ senderId: "a", content: [{ kind: "text", text: "x" }] }),
    });
    expect(res.status).toBe(403);
  });

  test("originAllowList accepts allowed origin", async () => {
    h = await startHarness({ originAllowList: ["https://app.example"] });
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example",
      },
      body: JSON.stringify({ senderId: "a", content: [{ kind: "text", text: "x" }] }),
    });
    expect(res.status).toBe(202);
  });

  test("messages with threadId only reach sockets subscribed to that thread", async () => {
    h = await startHarness();
    const wsA = new WebSocket(`ws://127.0.0.1:${h.port}/ws?thread=room-A`);
    const wsB = new WebSocket(`ws://127.0.0.1:${h.port}/ws?thread=room-B`);
    await Promise.all([
      new Promise<void>((r) => wsA.addEventListener("open", () => r(), { once: true })),
      new Promise<void>((r) => wsB.addEventListener("open", () => r(), { once: true })),
    ]);

    const aReceived: string[] = [];
    const bReceived: string[] = [];
    wsA.addEventListener("message", (e: MessageEvent) => aReceived.push(String(e.data)));
    wsB.addEventListener("message", (e: MessageEvent) => bReceived.push(String(e.data)));

    await h.adapter.send({
      content: [{ kind: "text", text: "for-A" }],
      threadId: "room-A",
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(aReceived).toHaveLength(1);
    expect(bReceived).toHaveLength(0);

    wsA.close();
    wsB.close();
  });

  test("unscoped sockets receive only unscoped messages, not threaded ones", async () => {
    h = await startHarness();
    const wsA = new WebSocket(`ws://127.0.0.1:${h.port}/ws?thread=room-A`);
    const wsUnscoped = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
    await Promise.all([
      new Promise<void>((r) => wsA.addEventListener("open", () => r(), { once: true })),
      new Promise<void>((r) => wsUnscoped.addEventListener("open", () => r(), { once: true })),
    ]);
    const aReceived: string[] = [];
    const uReceived: string[] = [];
    wsA.addEventListener("message", (e: MessageEvent) => aReceived.push(String(e.data)));
    wsUnscoped.addEventListener("message", (e: MessageEvent) => uReceived.push(String(e.data)));

    // Threaded message: only the matching thread subscriber gets it.
    await h.adapter.send({ content: [{ kind: "text", text: "for-A" }], threadId: "room-A" });
    // Unscoped message: only the unscoped subscriber gets it.
    await h.adapter.send({ content: [{ kind: "text", text: "no-thread" }] });
    await new Promise((r) => setTimeout(r, 30));

    expect(aReceived).toHaveLength(1);
    expect(uReceived).toHaveLength(1);
    expect(JSON.parse(aReceived[0] ?? "{}").content[0]?.text).toBe("for-A");
    expect(JSON.parse(uReceived[0] ?? "{}").content[0]?.text).toBe("no-thread");

    wsA.close();
    wsUnscoped.close();
  });

  test("WebSocket receives broadcast OutboundMessage", async () => {
    h = await startHarness();
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
    const opened = new Promise<void>((resolve) => {
      ws.addEventListener("open", () => resolve(), { once: true });
    });
    const message = new Promise<string>((resolve) => {
      ws.addEventListener("message", (event: MessageEvent) => resolve(String(event.data)), {
        once: true,
      });
    });
    await opened;
    await h.adapter.send({
      content: [{ kind: "text", text: "broadcasting" }],
    });
    const data = await message;
    const parsed = JSON.parse(data) as {
      readonly content: ReadonlyArray<{ readonly text?: string }>;
    };
    expect(parsed.content[0]?.text).toBe("broadcasting");
    ws.close();
  });

  test("send() rejects when not connected", async () => {
    h = await startHarness();
    await h.adapter.disconnect();
    await expect(h.adapter.send({ content: [{ kind: "text", text: "x" }] })).rejects.toThrow();
    h = await startHarness(); // restore for afterEach
  });

  test("revokeSubscriptions closes sockets matching the predicate (entitlement revocation)", async () => {
    h = await startHarness({ authenticate: (ctx) => ({ senderId: ctx.token ?? "anon" }) });
    const wsAlice = new WebSocket(`ws://127.0.0.1:${h.port}/ws?thread=t1`, {
      // Bun's WebSocket supports headers in the second arg
      headers: { authorization: "Bearer alice" },
    } as unknown as undefined);
    const wsBob = new WebSocket(`ws://127.0.0.1:${h.port}/ws?thread=t2`, {
      headers: { authorization: "Bearer bob" },
    } as unknown as undefined);
    await Promise.all([
      new Promise<void>((r) => wsAlice.addEventListener("open", () => r(), { once: true })),
      new Promise<void>((r) => wsBob.addEventListener("open", () => r(), { once: true })),
    ]);

    const aliceClosed = new Promise<number>((r) =>
      wsAlice.addEventListener("close", (e: CloseEvent) => r(e.code), { once: true }),
    );

    // Webhost decides Alice's access is revoked.
    const closed = (
      h.adapter as unknown as {
        readonly revokeSubscriptions: (
          p: (s: { readonly senderId: string; readonly threadId: string | undefined }) => boolean,
        ) => number;
      }
    ).revokeSubscriptions((s) => s.senderId === "alice");

    expect(closed).toBe(1);
    const code = await aliceClosed;
    expect(code).toBe(1008);

    // Bob's socket must remain open
    expect(wsBob.readyState).toBe(WebSocket.OPEN);
    wsBob.close();
  });

  test("revokeSubscriptions removes sockets from routing synchronously (no post-revoke leak)", async () => {
    // Regression: sending immediately after revoke must not deliver to
    // Alice even though Bun's async close handshake hasn't completed yet.
    h = await startHarness({ authenticate: (ctx) => ({ senderId: ctx.token ?? "anon" }) });
    const aliceMessages: string[] = [];
    const wsAlice = new WebSocket(`ws://127.0.0.1:${h.port}/ws?thread=t-shared`, {
      headers: { authorization: "Bearer alice" },
    } as unknown as undefined);
    wsAlice.addEventListener("message", (e: MessageEvent) => {
      aliceMessages.push(String(e.data));
    });
    await new Promise<void>((r) => wsAlice.addEventListener("open", () => r(), { once: true }));

    (
      h.adapter as unknown as {
        readonly revokeSubscriptions: (
          p: (s: { readonly senderId: string; readonly threadId: string | undefined }) => boolean,
        ) => number;
      }
    ).revokeSubscriptions((s) => s.senderId === "alice");

    // Send DURING the close handshake — must not reach Alice.
    await h.adapter.send({
      content: [{ kind: "text", text: "post-revoke" }],
      threadId: "t-shared",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(aliceMessages).toHaveLength(0);
  });

  test("send() rejects unthreaded outbound in authenticated mode (loud, not silent)", async () => {
    h = await startHarness({
      authenticate: () => ({ senderId: "alice" }),
    });
    await expect(h.adapter.send({ content: [{ kind: "text", text: "rootless" }] })).rejects.toThrow(
      /threadId/,
    );
  });

  test("onHandlerError forwards async dispatch failures so hosts can DLQ", async () => {
    const errors: Array<{ readonly err: unknown; readonly senderId: string }> = [];
    const adapter = createWebChannel({
      port: 0,
      hostname: "127.0.0.1",
      allowUnauthenticated: true,
      allowAnyOrigin: true,
      onHandlerError: (err, msg) => {
        errors.push({ err, senderId: msg.senderId });
      },
    });
    await adapter.connect();
    const port = (adapter as unknown as { readonly port: number }).port;
    adapter.onMessage(async () => {
      throw new Error("downstream-fail");
    });
    const res = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [{ kind: "text", text: "x" }] }),
    });
    expect(res.status).toBe(202); // ack synchronous
    await new Promise((r) => setTimeout(r, 20));
    expect(errors).toHaveLength(1);
    expect((errors[0]?.err as Error).message).toBe("downstream-fail");
    await adapter.disconnect();
  });

  test("Idempotency-Key suppresses duplicate dispatch within the window", async () => {
    h = await startHarness();
    const send = (): Promise<Response> =>
      fetch(`http://127.0.0.1:${h.port}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "tx-123" },
        body: JSON.stringify({ content: [{ kind: "text", text: "ping" }] }),
      });
    const r1 = await send();
    const r2 = await send();
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.received).toHaveLength(1); // duplicate dispatch suppressed
  });

  test("authenticated POST without threadId is rejected by default (fail-closed at boundary)", async () => {
    h = await startHarness({
      authenticate: () => ({ senderId: "alice" }),
    });
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [{ kind: "text", text: "no-thread" }] }),
    });
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.received).toHaveLength(0);
  });

  test("allowThreadlessAuthenticatedPost: true accepts threadless POSTs (explicit fire-and-forget)", async () => {
    h = await startHarness({
      authenticate: () => ({ senderId: "alice" }),
      allowThreadlessAuthenticatedPost: true,
    });
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [{ kind: "text", text: "fnf" }] }),
    });
    expect(res.status).toBe(202);
  });

  test("Idempotency-Key is scoped to principal — one tenant cannot suppress another's", async () => {
    h = await startHarness({
      authenticate: (ctx) => ({ senderId: ctx.token ?? "anon" }),
    });
    // Alice sends with key "shared". Composite cache key includes alice.
    const r1 = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer alice",
        "idempotency-key": "shared-key",
      },
      body: JSON.stringify({ content: [{ kind: "text", text: "from-alice" }], threadId: "t1" }),
    });
    expect(r1.status).toBe(202);
    // Bob sends the SAME raw header value. Must dispatch — different
    // composite key.
    const r2 = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer bob",
        "idempotency-key": "shared-key",
      },
      body: JSON.stringify({ content: [{ kind: "text", text: "from-bob" }], threadId: "t1" }),
    });
    expect(r2.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.received).toHaveLength(2);
  });

  test("Idempotency-Key reservation collapses concurrent retries to one dispatch", async () => {
    h = await startHarness();
    const send = (): Promise<Response> =>
      fetch(`http://127.0.0.1:${h.port}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "race-key" },
        body: JSON.stringify({ content: [{ kind: "text", text: "x" }] }),
      });
    // Fire concurrently — atomic reserve must collapse to one dispatch.
    const [r1, r2, r3] = await Promise.all([send(), send(), send()]);
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r3.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.received).toHaveLength(1);
  });

  test("Idempotency-Key NOT committed when first attempt fails (503), retry dispatches", async () => {
    // Regression: poisoning the idempotency cache on 503 turned transient
    // handler-absence into permanent loss for retrying clients. Failed
    // attempts must not record the key.
    const adapter = createWebChannel({
      port: 0,
      hostname: "127.0.0.1",
      allowUnauthenticated: true,
      allowAnyOrigin: true,
    });
    await adapter.connect();
    const port = (adapter as unknown as { readonly port: number }).port;
    // No onMessage yet → 503 first attempt
    const r1 = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "tx-startup" },
      body: JSON.stringify({ content: [{ kind: "text", text: "x" }] }),
    });
    expect(r1.status).toBe(503);
    // Now attach a handler
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    // Retry with the SAME key — must dispatch (key wasn't committed on 503)
    const r2 = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "tx-startup" },
      body: JSON.stringify({ content: [{ kind: "text", text: "x" }] }),
    });
    expect(r2.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  test("missing Idempotency-Key dispatches every POST (opt-in only)", async () => {
    h = await startHarness();
    const send = (): Promise<Response> =>
      fetch(`http://127.0.0.1:${h.port}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: [{ kind: "text", text: "x" }] }),
      });
    await send();
    await send();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.received).toHaveLength(2);
  });

  test("WS upgrade accepts `koi_ws` cookie (preferred over URL token)", async () => {
    h = await startHarness({
      authenticate: (ctx) => (ctx.token === "cookie-tok" ? { senderId: "alice" } : null),
    });
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws?thread=room-A`, {
      headers: { cookie: "other=ignored; koi_ws=cookie-tok; trailing=junk" },
    } as unknown as undefined);
    await new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true }));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("POST /messages enforces byte cap when Content-Length is missing/dishonest", async () => {
    // Regression: omitting Content-Length used to bypass the up-front check
    // and only fail after full buffering. Streaming reader must reject.
    h = await startHarness();
    // Use a ReadableStream so Bun's fetch sends chunked w/o Content-Length.
    const huge = new Uint8Array(1_100_000);
    huge.fill(0x78); // 'x'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(huge);
        controller.close();
      },
    });
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
    });
    expect(res.status).toBe(413);
  });

  test("WS upgrade requires ?thread= in authenticated mode (no shared unscoped broadcast)", async () => {
    h = await startHarness({
      authenticate: () => ({ senderId: "alice" }),
    });
    // No ?thread= → reject. Authenticated unscoped subscribers would form a
    // shared cross-tenant broadcast bucket for any unthreaded outbound send.
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
    const result = await new Promise<"open" | "error">((r) => {
      ws.addEventListener("open", () => r("open"), { once: true });
      ws.addEventListener("error", () => r("error"), { once: true });
    });
    expect(result).toBe("error");
  });

  test("WS upgrade accepts ?token= query (browsers can't set Authorization header)", async () => {
    h = await startHarness({
      authenticate: (ctx) => (ctx.token === "secret-tok" ? { senderId: "alice" } : null),
    });
    // Browser-style: token only in URL
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws?thread=room-A&token=secret-tok`);
    const opened = new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true }));
    await opened;
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("non-root config.path scopes routing — root /messages returns 404", async () => {
    h = await startHarness({ path: "/api", allowUnauthenticated: true });
    // Root path must not bypass the configured prefix.
    const root = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [{ kind: "text", text: "x" }] }),
    });
    expect(root.status).toBe(404);
    // Prefixed path resolves normally.
    const scoped = await fetch(`http://127.0.0.1:${h.port}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [{ kind: "text", text: "x" }] }),
    });
    expect(scoped.status).toBe(202);
  });

  test("POST /messages does NOT accept ?token= query — header only", async () => {
    // Regression: URL tokens leak via access logs/proxy logs/browser history.
    // The `?token=` fallback exists solely for the WS upgrade path where
    // browsers cannot set custom headers — POST /messages must require a
    // real Authorization header.
    h = await startHarness({
      authenticate: (ctx) => (ctx.token === "secret-tok" ? { senderId: "alice" } : null),
    });
    const res = await fetch(`http://127.0.0.1:${h.port}/messages?token=secret-tok`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [{ kind: "text", text: "hi" }] }),
    });
    expect(res.status).toBe(401);
  });

  test("WS upgrade rejects when ?token= is wrong", async () => {
    h = await startHarness({
      authenticate: (ctx) => (ctx.token === "good" ? { senderId: "u" } : null),
    });
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws?token=BAD`);
    const closed = new Promise<number>((r) =>
      ws.addEventListener("error", () => r(401), { once: true }),
    );
    expect(await closed).toBe(401);
  });

  test("OPTIONS preflight returns 204 with CORS headers for allowed origins", async () => {
    h = await startHarness({
      originAllowList: ["https://app.example"],
    });
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  test("OPTIONS preflight rejects disallowed origins with 403", async () => {
    h = await startHarness({ originAllowList: ["https://app.example"] });
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  test("POST /messages includes CORS headers on the actual response", async () => {
    h = await startHarness({
      originAllowList: ["https://app.example"],
      authenticate: () => ({ senderId: "alice" }),
    });
    const res = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example",
      },
      body: JSON.stringify({ content: [{ kind: "text", text: "hi" }], threadId: "t1" }),
    });
    expect(res.status).toBe(202);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });

  test("disconnect() drains in-flight WS sends", async () => {
    h = await startHarness();
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
    await new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true }));
    // No throw on disconnect with an open client
    await h.adapter.disconnect();
    h = await startHarness();
  });
});
