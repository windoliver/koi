import { describe, expect, test } from "bun:test";
import type { InboundMessage, TextBlock } from "@koi/core";
import { createIdeChannel, type IdeTransport } from "./ide-channel.js";

interface Harness {
  readonly transport: IdeTransport;
  readonly emitLine: (line: string) => void;
  readonly sent: string[];
  connectCount: number;
  disconnectCount: number;
}

function harness(): Harness {
  let listener: ((line: string) => void) | undefined;
  const sent: string[] = [];
  const h: Harness = {
    transport: {
      connect: async () => {
        h.connectCount++;
      },
      disconnect: async () => {
        h.disconnectCount++;
      },
      send: async (line) => {
        sent.push(line);
      },
      onLine: (handler) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
    },
    emitLine: (line) => listener?.(line),
    sent,
    connectCount: 0,
    disconnectCount: 0,
  };
  return h;
}

describe("createIdeChannel", () => {
  test("declares ide capabilities", () => {
    const h = harness();
    const ch = createIdeChannel({ transport: h.transport });
    expect(ch.capabilities.text).toBe(true);
    expect(ch.capabilities.files).toBe(true);
    expect(ch.capabilities.buttons).toBe(true);
    expect(ch.capabilities.audio).toBe(false);
  });

  test("name is 'ide'", () => {
    const h = harness();
    const ch = createIdeChannel({ transport: h.transport });
    expect(ch.name).toBe("ide");
  });

  test("connect/disconnect proxy to transport", async () => {
    const h = harness();
    const ch = createIdeChannel({ transport: h.transport });
    await ch.connect();
    await ch.disconnect();
    expect(h.connectCount).toBe(1);
    expect(h.disconnectCount).toBe(1);
  });

  test("inbound: notify frame → InboundMessage", async () => {
    const h = harness();
    const ch = createIdeChannel({ transport: h.transport });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      received.push(m);
    });
    await ch.connect();
    h.emitLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notify",
        params: { content: [{ kind: "text", text: "hi from ide" }] },
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    const block = received[0]?.content[0] as TextBlock | undefined;
    expect(block?.text).toBe("hi from ide");
    expect(received[0]?.senderId).toBe("ide-user");
    await ch.disconnect();
  });

  test("inbound: malformed ContentBlock dropped (no untyped object reaches handler)", async () => {
    const h = harness();
    const ch = createIdeChannel({ transport: h.transport });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      received.push(m);
    });
    await ch.connect();
    h.emitLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notify",
        params: { content: [{ kind: "image", url: 42 }] },
      }),
    );
    h.emitLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notify",
        params: { content: [{ kind: "text" }] },
      }),
    );
    h.emitLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notify",
        params: { content: [{ kind: "unknown" }] },
      }),
    );
    // A well-formed frame still gets through.
    h.emitLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notify",
        params: { content: [{ kind: "text", text: "ok" }] },
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    await ch.disconnect();
  });

  test("inbound: malformed JSON dropped silently", async () => {
    const h = harness();
    const ch = createIdeChannel({ transport: h.transport });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      received.push(m);
    });
    await ch.connect();
    h.emitLine("not json");
    h.emitLine(JSON.stringify({ jsonrpc: "2.0", method: "other" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(0);
    await ch.disconnect();
  });

  test("outbound: send writes JSON-RPC notify line with newline framing", async () => {
    const h = harness();
    const ch = createIdeChannel({ transport: h.transport });
    await ch.connect();
    await ch.send({ content: [{ kind: "text", text: "from agent" }] });
    expect(h.sent).toHaveLength(1);
    const written = h.sent[0] ?? "";
    expect(written.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(written.trimEnd());
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("notify");
    expect(parsed.params.content[0].text).toBe("from agent");
    await ch.disconnect();
  });

  test("outbound: back-to-back sends concatenated on a raw byte stream are recoverable line-by-line", async () => {
    // Regression: prior version omitted the delimiter, so two consecutive
    // sends produced "}{" on a transport that does not insert framing
    // itself (a real socket / stdio pair). Verify the channel inserts the
    // newline so a downstream line splitter can recover frame boundaries.
    let buffer = "";
    const transport: IdeTransport = {
      connect: async () => {},
      disconnect: async () => {},
      send: async (framed: string) => {
        buffer += framed;
      },
      onLine: () => () => {},
    };
    const ch = createIdeChannel({ transport });
    await ch.connect();
    await ch.send({ content: [{ kind: "text", text: "first" }] });
    await ch.send({ content: [{ kind: "text", text: "second" }] });
    await ch.send({ content: [{ kind: "text", text: "third" }] });
    const lines = buffer.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    const parsedTexts = lines.map((l) => {
      const f = JSON.parse(l) as { params: { content: { text: string }[] } };
      return f.params.content[0]?.text;
    });
    expect(parsedTexts).toEqual(["first", "second", "third"]);
    await ch.disconnect();
  });

  test("inbound: client-supplied senderId DROPPED by default (untrusted)", async () => {
    const h = harness();
    const ch = createIdeChannel({ transport: h.transport, senderId: "trusted-host" });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      received.push(m);
    });
    await ch.connect();
    h.emitLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notify",
        params: {
          content: [{ kind: "text", text: "x" }],
          senderId: "spoofed-attacker",
          threadId: "spoofed-thread",
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(received[0]?.senderId).toBe("trusted-host");
    expect(received[0]?.threadId).toBeUndefined();
    await ch.disconnect();
  });

  test("inbound: client-supplied senderId honored only when trustClientIdentity: true", async () => {
    const h = harness();
    const ch = createIdeChannel({ transport: h.transport, trustClientIdentity: true });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      received.push(m);
    });
    await ch.connect();
    h.emitLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notify",
        params: {
          content: [{ kind: "text", text: "x" }],
          senderId: "vscode-42",
          threadId: "thread-1",
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(received[0]?.senderId).toBe("vscode-42");
    expect(received[0]?.threadId).toBe("thread-1");
    await ch.disconnect();
  });
});
