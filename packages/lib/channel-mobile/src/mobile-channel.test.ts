import { describe, expect, test } from "bun:test";
import type { InboundMessage, OutboundMessage, TextBlock } from "@koi/core";
import { createMobileChannel } from "./mobile-channel.js";

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
  test("declares mobile capabilities", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port });
    expect(ch.capabilities.text).toBe(true);
    expect(ch.capabilities.images).toBe(true);
    expect(ch.capabilities.files).toBe(true);
    expect(ch.capabilities.buttons).toBe(true);
    expect(ch.name).toBe("mobile");
  });

  test("inbound: client msg → InboundMessage", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
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
    await ch.send({ content: [{ kind: "text", text: "down" }] });
    const frame = (await framePromise) as { kind: string; content: { text: string }[] };
    expect(frame.kind).toBe("msg");
    expect(frame.content[0]?.text).toBe("down");
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("offline queue: outbound buffered while no client; flushed on connect", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port, maxOfflineQueue: 5 });
    await ch.connect();
    await ch.send({ content: [{ kind: "text", text: "a" }] });
    await ch.send({ content: [{ kind: "text", text: "b" }] });
    expect(ch.queueDepth()).toBe(2);

    const ws = await openWs(port);
    const got: string[] = [];
    ws.addEventListener("message", (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
        content: { text: string }[];
      };
      got.push(f.content[0]?.text ?? "");
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual(["a", "b"]);
    expect(ch.queueDepth()).toBe(0);
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("offline queue caps at maxOfflineQueue (FIFO drop)", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port, maxOfflineQueue: 2 });
    await ch.connect();
    await ch.send({ content: [{ kind: "text", text: "a" }] });
    await ch.send({ content: [{ kind: "text", text: "b" }] });
    await ch.send({ content: [{ kind: "text", text: "c" }] });
    expect(ch.queueDepth()).toBe(2);
    await ch.disconnect();
  });

  test("strict single-client: a second concurrent connection is rejected, not preemptive", async () => {
    // ws1 connects and stays connected. ws2 attempts to connect while ws1
    // is active — server must close ws2 immediately. Replies for ws1 must
    // continue to flow to ws1, with no possibility of misrouting to ws2.
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
    // ws2 attempts to connect — server must reject by closing.
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    let ws2Closed = false;
    ws2.addEventListener("close", () => {
      ws2Closed = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(ws2Closed).toBe(true);
    // Reply destined for ws1 must reach ws1 (which still holds the socket).
    await ch.send({ content: [{ kind: "text", text: "for-ws1" }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(got1).toEqual(["for-ws1"]);
    ws1.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("inbound: client-supplied senderId DROPPED by default (untrusted)", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port, senderId: "trusted-host" });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      received.push(m);
    });
    await ch.connect();
    const ws = await openWs(port);
    ws.send(
      JSON.stringify({
        kind: "msg",
        content: [{ kind: "text", text: "x" }],
        senderId: "spoofed-attacker",
        threadId: "spoofed-thread",
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(received[0]?.senderId).toBe("trusted-host");
    expect(received[0]?.threadId).toBeUndefined();
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("inbound: client-supplied senderId honored only when trustClientIdentity: true", async () => {
    const port = await freePort();
    const ch = createMobileChannel({ port, trustClientIdentity: true });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      received.push(m);
    });
    await ch.connect();
    const ws = await openWs(port);
    ws.send(
      JSON.stringify({
        kind: "msg",
        content: [{ kind: "text", text: "x" }],
        senderId: "device-1",
        threadId: "t-1",
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(received[0]?.senderId).toBe("device-1");
    expect(received[0]?.threadId).toBe("t-1");
    ws.close();
    await new Promise((r) => setTimeout(r, 10));
    await ch.disconnect();
  });

  test("pushNotifier called when no client connected", async () => {
    const port = await freePort();
    const pushed: OutboundMessage[] = [];
    const ch = createMobileChannel({
      port,
      pushNotifier: async (m) => {
        pushed.push(m);
      },
    });
    await ch.connect();
    await ch.send({ content: [{ kind: "text", text: "ping" }] });
    expect(pushed).toHaveLength(1);
    await ch.disconnect();
  });
});
