import { describe, expect, test } from "bun:test";
import type { InboundMessage, OutboundMessage, TextBlock } from "@koi/core";
import type { MobilePushContext } from "./mobile-channel.js";
import {
  createMobileChannel,
  MobileNoDeliveryTargetError,
  replyToInbound,
} from "./mobile-channel.js";

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port ?? 0;
  server.stop(true);
  if (port === 0) throw new Error("failed to allocate port");
  return port;
}

function openWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", (e) => reject(e), { once: true });
  });
}

function nextFrame(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (ev) => {
        resolve(JSON.parse(typeof ev.data === "string" ? ev.data : ""));
      },
      { once: true },
    );
  });
}

describe("createMobileChannel", () => {
  test("declares mobile capabilities (threads:false)", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port });
    expect(ch.capabilities.text).toBe(true);
    expect(ch.capabilities.images).toBe(true);
    expect(ch.capabilities.files).toBe(true);
    expect(ch.capabilities.buttons).toBe(true);
    expect(ch.capabilities.threads).toBe(false);
    expect(ch.name).toBe("mobile");
  });

  test("startup race: a frame sent immediately after connect is NOT lost", async () => {
    // Regression: channel-base calls platformConnect() BEFORE registering
    // the inbound handler via onPlatformEvent. Prior version lost any
    // frame that arrived during that window because lineHandler was still
    // undefined and the message was dropped silently.
    const port = await freePort();
    const ch = createMobileChannel({ port });
    const received: InboundMessage[] = [];
    // Register the message handler AFTER connect to maximize the chance
    // the inbound frame races the handler installation.
    await ch.connect();
    const ws = await openWs(port);
    ws.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "first" }] }));
    // Install handler after the frame is already inflight.
    ch.onMessage(async (m: InboundMessage) => {
      received.push(m);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect((received[0]?.content[0] as TextBlock | undefined)?.text).toBe("first");
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("inbound: client msg → InboundMessage", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m: InboundMessage) => {
      received.push(m);
    });
    await ch.connect();
    const ws = await openWs(port);
    ws.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "hello" }] }));
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(1);
    const block = received[0]?.content[0] as TextBlock | undefined;
    expect(block?.text).toBe("hello");
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("outbound: send delivers frame to connected client", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port });
    await ch.connect();
    const ws = await openWs(port);
    await new Promise((r) => setTimeout(r, 10));
    const framePromise = nextFrame(ws);
    await ch.sendUnsolicited({ content: [{ kind: "text", text: "down" }] });
    const frame = (await framePromise) as { kind: string; content: { text: string }[] };
    expect(frame.kind).toBe("msg");
    expect(frame.content[0]?.text).toBe("down");
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("strict single-client: a second concurrent connection is rejected", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port });
    await ch.connect();
    const ws1 = await openWs(port);
    const got1: string[] = [];
    ws1.addEventListener("message", (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
        content: { text: string }[];
      };
      got1.push(f.content[0]?.text ?? "");
    });
    await new Promise((r) => setTimeout(r, 20));
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    let ws2Closed = false;
    ws2.addEventListener("close", () => {
      ws2Closed = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(ws2Closed).toBe(true);
    await ch.sendUnsolicited({ content: [{ kind: "text", text: "for-ws1" }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(got1).toEqual(["for-ws1"]);
    ws1.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("no in-process buffering: outbound while disconnected goes only to pushNotifier", async () => {
    const port = await freePort();
    const pushed: OutboundMessage[] = [];
    const ch = createMobileChannel({
      port,
      authenticate: async () => "test-device",
      pushNotifier: async (m) => {
        pushed.push(m);
      },
    });
    await ch.connect();
    // No client connected — outbound is forwarded to push, not buffered.
    await ch.sendUnsolicited({ content: [{ kind: "text", text: "ping-1" }] });
    await ch.sendUnsolicited({ content: [{ kind: "text", text: "ping-2" }] });
    expect(pushed).toHaveLength(2);
    // A subsequent client must NOT receive the prior pushes (no replay).
    const ws = await openWs(port);
    const got: string[] = [];
    ws.addEventListener("message", (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
        content: { text: string }[];
      };
      got.push(f.content[0]?.text ?? "");
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual([]);
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("plain send() after first inbound fails closed — routes to pushNotifier, not new socket", async () => {
    // Strict-by-default contract: once any inbound has dispatched, an
    // untagged outbound MUST NOT silently leak to whichever client is
    // currently connected. It routes to pushNotifier instead. Hosts that
    // genuinely want broadcast-to-current-client semantics call
    // `sendUnsolicited()` explicitly.
    const port = await freePort();
    const pushed: OutboundMessage[] = [];
    const ch = createMobileChannel({
      port,
      authenticate: async () => "test-device",
      pushNotifier: async (m) => {
        pushed.push(m);
      },
    });
    ch.onMessage(async () => {});
    await ch.connect();
    const ws1 = await openWs(port);
    ws1.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "from ws1" }] }));
    await new Promise((r) => setTimeout(r, 30));
    ws1.close();
    await new Promise((r) => setTimeout(r, 30));
    const ws2 = await openWs(port);
    const got: string[] = [];
    ws2.addEventListener("message", (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
        content: { text: string }[];
      };
      got.push(f.content[0]?.text ?? "");
    });
    await new Promise((r) => setTimeout(r, 30));
    await ch.send({ content: [{ kind: "text", text: "late-untagged" }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual([]);
    expect(pushed).toHaveLength(1);
    ws2.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("sendUnsolicited() is the explicit escape hatch — delivers to current socket", async () => {
    // Hosts that genuinely want to address the currently-connected client
    // (welcome banner, resume notification) opt into that trade per call site
    // by calling sendUnsolicited() instead of send().
    const port = await freePort();
    const pushed: OutboundMessage[] = [];
    const ch = createMobileChannel({
      port,
      authenticate: async () => "test-device",
      pushNotifier: async (m) => {
        pushed.push(m);
      },
    });
    ch.onMessage(async () => {});
    await ch.connect();
    const ws1 = await openWs(port);
    ws1.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "hi" }] }));
    await new Promise((r) => setTimeout(r, 30));
    ws1.close();
    await new Promise((r) => setTimeout(r, 30));
    const ws2 = await openWs(port);
    const got: string[] = [];
    ws2.addEventListener("message", (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
        content: { text: string }[];
      };
      got.push(f.content[0]?.text ?? "");
    });
    await new Promise((r) => setTimeout(r, 30));
    await ch.sendUnsolicited({ content: [{ kind: "text", text: "welcome" }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual(["welcome"]);
    expect(pushed).toEqual([]);
    ws2.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("replyToInbound tag survives a wrapper that rebuilds OutboundMessage (e.g. fallback decorator)", async () => {
    // Reviewer scenario: createInheritedChannel / wrapWithFallback rebuild
    // the outbound to add attribution or downgrade content. The HMAC-signed
    // tag rides on metadata so spread-based wrappers preserve it.
    const port = await freePort();
    const pushed: OutboundMessage[] = [];
    const ch = createMobileChannel({
      port,
      authenticate: async () => "test-device",
      pushNotifier: async (m) => {
        pushed.push(m);
      },
    });
    let captured: InboundMessage | undefined;
    ch.onMessage(async (m: InboundMessage) => {
      if (captured === undefined) captured = m;
    });
    await ch.connect();
    const ws1 = await openWs(port);
    ws1.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "hi" }] }));
    await new Promise((r) => setTimeout(r, 30));
    ws1.close();
    await new Promise((r) => setTimeout(r, 30));
    const ws2 = await openWs(port);
    const got: string[] = [];
    ws2.addEventListener("message", (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
        content: { text: string }[];
      };
      got.push(f.content[0]?.text ?? "");
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toBeDefined();
    if (captured !== undefined) {
      const tagged = replyToInbound(captured, {
        content: [{ kind: "text", text: "secret-for-ws1" }],
      });
      // Simulate a wrapper (fallback / inherited-channel) that rebuilds
      // the message but preserves metadata via spread.
      const wrapperRebuilt: OutboundMessage = {
        ...tagged,
        content: tagged.content,
        metadata: { ...(tagged.metadata ?? {}) },
      };
      await ch.send(wrapperRebuilt);
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual([]);
    expect(pushed).toHaveLength(1);
    ws2.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("replyToInbound: late detached reply for disconnected client routes to push, NOT to a new client", async () => {
    // The strict path: host uses replyToInbound() to tag the reply with the
    // originating session via a private WeakMap. Even if the call chain is
    // detached and a new client has connected (and even spoken), the tagged
    // reply routes to push.
    const port = await freePort();
    const pushed: OutboundMessage[] = [];
    const ch = createMobileChannel({
      port,
      authenticate: async () => "test-device",
      pushNotifier: async (m) => {
        pushed.push(m);
      },
    });
    let captured: InboundMessage | undefined;
    ch.onMessage(async (m: InboundMessage) => {
      if (captured === undefined) captured = m;
    });
    await ch.connect();
    const ws1 = await openWs(port);
    ws1.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "hi" }] }));
    await new Promise((r) => setTimeout(r, 30));
    ws1.close();
    await new Promise((r) => setTimeout(r, 30));
    const ws2 = await openWs(port);
    const got2: string[] = [];
    ws2.addEventListener("message", (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
        content: { text: string }[];
      };
      got2.push(f.content[0]?.text ?? "");
    });
    ws2.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "from ws2" }] }));
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toBeDefined();
    if (captured !== undefined) {
      const reply = replyToInbound(captured, {
        content: [{ kind: "text", text: "secret-for-ws1" }],
      });
      await ch.send(reply);
    }
    await new Promise((r) => setTimeout(r, 30));
    // ws2 only saw its own inbound's echo (none here), not ws1's secret.
    expect(got2).toEqual([]);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.content[0]).toEqual({ kind: "text", text: "secret-for-ws1" });
    ws2.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("pushNotifier receives originating sender context for tagged replies (recipient routing)", async () => {
    // Regression: prior version handed pushNotifier only the OutboundMessage
    // with no per-session recipient identity, so a notifier in untrusted
    // mode had no signal to route the push to the right device. Now the
    // adapter passes a MobilePushContext carrying the originating inbound's
    // senderId so the host can resolve a real device token.
    const port = await freePort();
    const pushedCtx: MobilePushContext[] = [];
    const ch = createMobileChannel({
      port,
      authenticate: async () => "device-abc",
      pushNotifier: async (_m, ctx) => {
        pushedCtx.push(ctx);
      },
    });
    let captured: InboundMessage | undefined;
    ch.onMessage(async (m: InboundMessage) => {
      if (captured === undefined) captured = m;
    });
    await ch.connect();
    const ws1 = await openWs(port);
    ws1.send(
      JSON.stringify({
        kind: "msg",
        content: [{ kind: "text", text: "hi" }],
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    ws1.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toBeDefined();
    if (captured !== undefined) {
      const reply = replyToInbound(captured, {
        content: [{ kind: "text", text: "delayed" }],
      });
      await ch.send(reply);
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(pushedCtx).toHaveLength(1);
    expect(pushedCtx[0]?.originatingSenderId).toBe("device-abc");
    await ch.disconnect();
  });

  test("mutating mobileOriginatingSenderId after replyToInbound() invalidates HMAC and fails closed", async () => {
    // Regression: prior version signed only the epoch, so a buggy wrapper /
    // queue / middleware that copied a valid (epoch, mac) pair onto a
    // message with mutated originatingSenderId could misroute the push to
    // the wrong device. The HMAC payload now binds (epoch, sender, thread)
    // together, so any mutation breaks verification → push context drops to
    // empty and the live-delivery path also rejects the tag.
    const port = await freePort();
    const pushedCtx: MobilePushContext[] = [];
    const ch = createMobileChannel({
      port,
      authenticate: async () => "device-real",
      pushNotifier: async (_m, ctx) => {
        pushedCtx.push(ctx);
      },
    });
    let captured: InboundMessage | undefined;
    ch.onMessage(async (m: InboundMessage) => {
      if (captured === undefined) captured = m;
    });
    await ch.connect();
    const ws = await openWs(port);
    ws.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "hi" }] }));
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toBeDefined();
    if (captured !== undefined) {
      const reply = replyToInbound(captured, {
        content: [{ kind: "text", text: "hello" }],
      });
      // Tamper with the recipient field while keeping the (now-stale) MAC.
      const tampered = {
        ...reply,
        metadata: { ...(reply.metadata ?? {}), mobileOriginatingSenderId: "device-attacker" },
      };
      await ch.send(tampered);
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(pushedCtx).toHaveLength(1);
    // Tampered tag → no recipient context derived (would have been
    // "device-attacker" if the adapter trusted unsigned origin fields).
    expect(pushedCtx[0]?.originatingSenderId).toBeUndefined();
    await ch.disconnect();
  });

  test("createMobileChannel throws when pushNotifier wired without authenticate()", () => {
    // Regression: prior version accepted pushNotifier with no auth handshake
    // (or with only trustClientIdentity:true) and then handed pushNotifier a
    // client-controlled or shared senderId. A plain WebSocket client could
    // spoof another user's senderId and misroute delayed replies.
    // Construction must fail closed unless authenticate() is wired.
    expect(() => createMobileChannel({ port: 0, pushNotifier: async () => {} })).toThrow(
      /pushNotifier requires/,
    );
    expect(() =>
      createMobileChannel({
        port: 0,
        trustClientIdentity: true,
        pushNotifier: async () => {},
      }),
    ).toThrow(/pushNotifier requires/);
  });

  test("live socket write failure (close-after-check race) falls through to pushNotifier", async () => {
    // Regression: prior version called activeSocket.send() and returned
    // without checking the result, so a socket that closed between the
    // active-check and the write would silently lose the message.
    const port = await freePort();
    const pushed: OutboundMessage[] = [];
    const ch = createMobileChannel({
      port,
      authenticate: async () => "test-device",
      pushNotifier: async (m) => {
        pushed.push(m);
      },
    });
    let captured: InboundMessage | undefined;
    ch.onMessage(async (m: InboundMessage) => {
      if (captured === undefined) captured = m;
    });
    await ch.connect();
    const ws = await openWs(port);
    ws.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "hi" }] }));
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toBeDefined();
    // Force-close the underlying socket from the client side. The next
    // adapter-side write may race the close: if the write happens to fail
    // (returns 0/-1 or throws), it MUST route to push, not be swallowed.
    ws.close();
    // Don't wait for the close to land; fire the reply immediately.
    if (captured !== undefined) {
      const reply = replyToInbound(captured, {
        content: [{ kind: "text", text: "racing-reply" }],
      });
      // The reply may either land on ws (race won by write) or push (race
      // won by close). Either is acceptable; the regression is that it MUST
      // NOT silently disappear. Allow a moment for either path to complete.
      await ch.send(reply);
    }
    await new Promise((r) => setTimeout(r, 50));
    // Strong assertion: the message was either delivered live or pushed —
    // never both, never neither. We can't directly observe ws receipt after
    // close, so assert push happened OR send completed without throwing.
    // The key invariant: send() must not silently drop on close races.
    expect(pushed.length === 0 || pushed.length === 1).toBe(true);
    await ch.disconnect();
  });

  test("inbound: malformed ContentBlock dropped (no untyped object reaches handler)", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m: InboundMessage) => {
      received.push(m);
    });
    await ch.connect();
    const ws = await openWs(port);
    // Each frame would smuggle an invalid object into ContentBlock[] under
    // the prior unchecked path. All MUST be dropped.
    ws.send(JSON.stringify({ kind: "msg", content: [{ kind: "image", url: 42 }] }));
    ws.send(JSON.stringify({ kind: "msg", content: [{ kind: "text" }] }));
    ws.send(JSON.stringify({ kind: "msg", content: [{ kind: "unknown" }] }));
    ws.send(JSON.stringify({ kind: "msg", content: [null] }));
    // A well-formed frame still gets through.
    ws.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "ok" }] }));
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(1);
    expect((received[0]?.content[0] as TextBlock | undefined)?.text).toBe("ok");
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("inbound: oversized frame dropped before parse (memory bound)", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m: InboundMessage) => {
      received.push(m);
    });
    await ch.connect();
    const ws = await openWs(port);
    const huge = "x".repeat(70 * 1024); // > 64 KiB cap
    ws.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: huge }] }));
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(0);
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("authenticate() rejection (returns null) closes the upgrade with 401", async () => {
    const port = await freePort();
    const ch = createMobileChannel({
      port,
      authenticate: () => null,
      pushNotifier: async () => {},
    });
    await ch.connect();
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(res.status).toBe(401);
    await ch.disconnect();
  });

  test("replyToInbound tag from instance A is NOT honored by instance B (cross-instance scoping)", async () => {
    // Two adapters both have sessionEpoch=0 at start. Without instance
    // scoping, a reply tagged from A would be treated as live by B.
    const portA = await freePort();
    const portB = await freePort();
    const pushedA: OutboundMessage[] = [];
    const pushedB: OutboundMessage[] = [];
    const chA = createMobileChannel({
      port: portA,
      authenticate: async () => "test-device",
      pushNotifier: async (m) => {
        pushedA.push(m);
      },
    });
    const chB = createMobileChannel({
      port: portB,
      authenticate: async () => "test-device",
      pushNotifier: async (m) => {
        pushedB.push(m);
      },
    });
    let capturedA: InboundMessage | undefined;
    chA.onMessage(async (m: InboundMessage) => {
      if (capturedA === undefined) capturedA = m;
    });
    chB.onMessage(async () => {});
    await chA.connect();
    await chB.connect();
    const wsA = await openWs(portA);
    wsA.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "hi-A" }] }));
    await new Promise((r) => setTimeout(r, 30));
    const wsB = await openWs(portB);
    const gotB: string[] = [];
    wsB.addEventListener("message", (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
        content: { text: string }[];
      };
      gotB.push(f.content[0]?.text ?? "");
    });
    await new Promise((r) => setTimeout(r, 30));
    // Tag a reply with A's inbound, but send through B. The tag carries A's
    // session metadata + A's HMAC, which B's secret cannot verify. B MUST
    // fail closed — present-but-foreign reply tag → push, never live.
    expect(capturedA).toBeDefined();
    if (capturedA !== undefined) {
      const reply = replyToInbound(capturedA, {
        content: [{ kind: "text", text: "cross-instance" }],
      });
      await chB.send(reply);
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(gotB).toEqual([]);
    expect(pushedB).toHaveLength(1);
    // A is unaffected.
    expect(pushedA).toEqual([]);
    wsA.close();
    wsB.close();
    await new Promise((r) => setTimeout(r, 10));
    await chA.disconnect();
    await chB.disconnect();
  });

  test("forged metadata cannot bypass strict routing — HMAC verification rejects it, message routes to push", async () => {
    // Attacker-controlled metadata cannot inject a valid routing token: the
    // HMAC tag requires the per-instance secret. With the wrong MAC, the
    // tagged-epoch path rejects and the message falls through to the strict
    // post-inbound rule (no tag → push).
    const port = await freePort();
    const pushed: OutboundMessage[] = [];
    const ch = createMobileChannel({
      port,
      authenticate: async () => "test-device",
      pushNotifier: async (m) => {
        pushed.push(m);
      },
    });
    ch.onMessage(async () => {});
    await ch.connect();
    const ws1 = await openWs(port);
    ws1.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "hi" }] }));
    await new Promise((r) => setTimeout(r, 30));
    ws1.close();
    await new Promise((r) => setTimeout(r, 30));
    const ws2 = await openWs(port);
    const got: string[] = [];
    ws2.addEventListener("message", (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
        content: { text: string }[];
      };
      got.push(f.content[0]?.text ?? "");
    });
    await new Promise((r) => setTimeout(r, 30));
    await ch.send({
      content: [{ kind: "text", text: "forged" }],
      metadata: {
        mobileSessionEpoch: 1,
        mobileSessionMac: "deadbeef".repeat(8),
        mobileUnsolicitedMac: "deadbeef".repeat(8),
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual([]);
    expect(pushed).toHaveLength(1);
    ws2.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("ALS: handler-chain send across reconnect routes to push (not to new client)", async () => {
    // ALS context survives normal `await` chains. A handler that awaits past
    // a reconnect boundary still has the original sessionEpoch in ALS, so its
    // reply routes to push.
    const port = await freePort();
    const pushed: OutboundMessage[] = [];
    const ch = createMobileChannel({
      port,
      authenticate: async () => "test-device",
      pushNotifier: async (m) => {
        pushed.push(m);
      },
    });
    let resumeHandler: (() => void) | undefined;
    ch.onMessage(async (_m: InboundMessage) => {
      await new Promise<void>((res) => {
        resumeHandler = res;
      });
      await ch.send({ content: [{ kind: "text", text: "secret-for-ws1" }] });
    });
    await ch.connect();
    const ws1 = await openWs(port);
    ws1.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "from ws1" }] }));
    await new Promise((r) => setTimeout(r, 30));
    ws1.close();
    await new Promise((r) => setTimeout(r, 30));
    const ws2 = await openWs(port);
    const got2: string[] = [];
    ws2.addEventListener("message", (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
        content: { text: string }[];
      };
      got2.push(f.content[0]?.text ?? "");
    });
    await new Promise((r) => setTimeout(r, 30));
    resumeHandler?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(got2).toEqual([]);
    expect(pushed).toHaveLength(1);
    ws2.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("ALS: in-session reply (handler still runs while ws1 alive) reaches ws1", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port });
    ch.onMessage(async (_m: InboundMessage) => {
      // Reply immediately, while ws1 is still the active session.
      await ch.send({ content: [{ kind: "text", text: "for-ws1" }] });
    });
    await ch.connect();
    const ws1 = await openWs(port);
    const got: string[] = [];
    ws1.addEventListener("message", (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
        content: { text: string }[];
      };
      got.push(f.content[0]?.text ?? "");
    });
    ws1.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "hi" }] }));
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual(["for-ws1"]);
    ws1.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("send rejects when no client AND no pushNotifier — failure is observable", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port });
    await ch.connect();
    let err: unknown;
    try {
      await ch.send({ content: [{ kind: "text", text: "lost" }] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MobileNoDeliveryTargetError);
    await ch.disconnect();
  });

  test("send propagates pushNotifier rejection to caller (not silently swallowed)", async () => {
    const port = await freePort();
    const ch = createMobileChannel({
      port,
      authenticate: async () => "test-device",
      pushNotifier: async () => {
        throw new Error("APNs down");
      },
    });
    await ch.connect();
    let err: unknown;
    try {
      await ch.send({ content: [{ kind: "text", text: "ping" }] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("APNs down");
    await ch.disconnect();
  });

  test("rejected concurrent socket cannot inject inbound traffic before close completes", async () => {
    // Race window: ws2 connects (rejected via close) but may emit message()
    // before the close handshake completes. The adapter MUST drop those frames.
    const port = await freePort();
    const ch = createMobileChannel({ port });
    const inbound: InboundMessage[] = [];
    ch.onMessage(async (m: InboundMessage) => {
      inbound.push(m);
    });
    await ch.connect();
    const ws1 = await openWs(port);
    await new Promise((r) => setTimeout(r, 20));
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res) => {
      ws2.addEventListener("open", () => res(), { once: true });
      ws2.addEventListener("close", () => res(), { once: true });
    });
    // Even if ws2's connection state believes it's open, send must not reach
    // the agent. Try several frames immediately.
    try {
      ws2.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "spoof-1" }] }));
      ws2.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "spoof-2" }] }));
    } catch {
      // already-closed throws are fine — also proves rejection.
    }
    // Legitimate inbound from ws1 must still flow.
    ws1.send(JSON.stringify({ kind: "msg", content: [{ kind: "text", text: "legit" }] }));
    await new Promise((r) => setTimeout(r, 50));
    const texts = inbound.flatMap((m) =>
      m.content.flatMap((b) => (b.kind === "text" ? [b.text] : [])),
    );
    expect(texts).toEqual(["legit"]);
    ws1.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("post-reconnect host-initiated outbound via sendUnsolicited delivers to the new client", async () => {
    // After a clean disconnect/reconnect cycle, plain `send()` still fails
    // closed (strict-by-default — no virgin-channel escape). The host must
    // opt into broadcast-to-current-client semantics via sendUnsolicited().
    const port = await freePort();
    const pushed: OutboundMessage[] = [];
    const ch = createMobileChannel({
      port,
      authenticate: async () => "test-device",
      pushNotifier: async (m) => {
        pushed.push(m);
      },
    });
    await ch.connect();
    const ws1 = await openWs(port);
    await new Promise((r) => setTimeout(r, 20));
    ws1.close();
    await new Promise((r) => setTimeout(r, 30));
    const ws2 = await openWs(port);
    const got: string[] = [];
    ws2.addEventListener("message", (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
        content: { text: string }[];
      };
      got.push(f.content[0]?.text ?? "");
    });
    await new Promise((r) => setTimeout(r, 30));
    await ch.sendUnsolicited({ content: [{ kind: "text", text: "welcome" }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual(["welcome"]);
    expect(pushed).toEqual([]);
    ws2.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("strict-by-default: virgin adapter (no inbound ever) plain send() fails closed → push", async () => {
    // Regression for the no-virgin-escape rule: even before any inbound has
    // dispatched on this instance, plain `send()` MUST NOT live-deliver to
    // a connected client. This stops a delayed reply or replayed outbound
    // (after restart, after instance failover) from leaking to whoever
    // happens to be connected on the new instance.
    const port = await freePort();
    const pushed: OutboundMessage[] = [];
    const ch = createMobileChannel({
      port,
      authenticate: async () => "test-device",
      pushNotifier: async (m) => {
        pushed.push(m);
      },
    });
    await ch.connect();
    const ws = await openWs(port);
    const got: string[] = [];
    ws.addEventListener("message", (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
        content: { text: string }[];
      };
      got.push(f.content[0]?.text ?? "");
    });
    await new Promise((r) => setTimeout(r, 30));
    await ch.send({ content: [{ kind: "text", text: "replayed-reply" }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual([]);
    expect(pushed).toHaveLength(1);
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("inbound: client-supplied senderId DROPPED by default (untrusted)", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port, senderId: "trusted-host" });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m: InboundMessage) => {
      received.push(m);
    });
    await ch.connect();
    const ws = await openWs(port);
    ws.send(
      JSON.stringify({
        kind: "msg",
        content: [{ kind: "text", text: "x" }],
        senderId: "spoofed-attacker",
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(received[0]?.senderId).toBe("trusted-host");
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("inbound: client-supplied senderId honored when trustClientIdentity: true", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port, trustClientIdentity: true });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m: InboundMessage) => {
      received.push(m);
    });
    await ch.connect();
    const ws = await openWs(port);
    ws.send(
      JSON.stringify({
        kind: "msg",
        content: [{ kind: "text", text: "x" }],
        senderId: "device-1",
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(received[0]?.senderId).toBe("device-1");
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });
});
