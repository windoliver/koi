import { describe, expect, test } from "bun:test";
import type { InboundMessage, OutboundMessage, TextBlock } from "@koi/core";
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

  test("replyToInbound tag from instance A is NOT honored by instance B (cross-instance scoping)", async () => {
    // Two adapters both have sessionEpoch=0 at start. Without instance
    // scoping, a reply tagged from A would be treated as live by B.
    const portA = await freePort();
    const portB = await freePort();
    const pushedA: OutboundMessage[] = [];
    const pushedB: OutboundMessage[] = [];
    const chA = createMobileChannel({
      port: portA,
      pushNotifier: async (m) => {
        pushedA.push(m);
      },
    });
    const chB = createMobileChannel({
      port: portB,
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
