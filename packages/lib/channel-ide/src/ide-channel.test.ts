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

  test("trustClientIdentity: malformed senderId/threadId values drop the frame", async () => {
    // Regression: round-5 trust-mode forwarded params.senderId / params.threadId
    // verbatim with only ?? checks, so a buggy or compromised plugin could
    // smuggle non-string values into InboundMessage and corrupt downstream
    // routing (which assumes string IDs). Each malformed shape MUST be
    // rejected; a well-formed frame still gets through.
    const h = harness();
    const ch = createIdeChannel({ transport: h.transport, trustClientIdentity: true });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      received.push(m);
    });
    await ch.connect();
    const malformed: ReadonlyArray<Record<string, unknown>> = [
      { senderId: 42 },
      { senderId: "" },
      { senderId: null },
      { senderId: { evil: true } },
      { threadId: 42 },
      { threadId: "" },
      { threadId: null },
      { threadId: ["thread"] },
    ];
    for (const params of malformed) {
      h.emitLine(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notify",
          params: { content: [{ kind: "text", text: "x" }], ...params },
        }),
      );
    }
    h.emitLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notify",
        params: { content: [{ kind: "text", text: "ok" }], senderId: "good", threadId: "t1" },
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    expect(received[0]?.senderId).toBe("good");
    expect(received[0]?.threadId).toBe("t1");
    await ch.disconnect();
  });

  test("startup race: line emitted synchronously during transport.connect() is NOT lost", async () => {
    // Regression: previously the IDE adapter only registered its
    // line listener AFTER awaiting transport.connect(), so a transport
    // that flushed a queued first notify synchronously inside its own
    // connect() (real-world case: editor plugins that buffer outbound
    // and drain on pipe-open) lost that frame. Subscribing BEFORE
    // connect routes it into the bounded pre-handler buffer instead.
    const queuedLine = JSON.stringify({
      jsonrpc: "2.0",
      method: "notify",
      params: { content: [{ kind: "text", text: "racing-first" }] },
    });
    // let requires justification: captured by transport callback wiring
    let listener: ((line: string) => void) | undefined;
    const racyTransport = {
      connect: async (): Promise<void> => {
        listener?.(queuedLine);
      },
      disconnect: async (): Promise<void> => {},
      send: async (): Promise<void> => {},
      onLine: (handler: (l: string) => void): (() => void) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
    };
    const ch = createIdeChannel({ transport: racyTransport });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      received.push(m);
    });
    await ch.connect();
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect((received[0]?.content[0] as TextBlock | undefined)?.text).toBe("racing-first");
    await ch.disconnect();
  });

  test("inbound size cap is enforced on UTF-8 bytes, not UTF-16 code units", async () => {
    // Regression: round-7 used line.length so a frame full of multi-byte
    // chars could exceed the 256 KiB byte cap by 3-4x and still parse,
    // bypassing the only memory guard at the IDE trust boundary.
    const h = harness();
    const ch = createIdeChannel({ transport: h.transport });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      received.push(m);
    });
    await ch.connect();
    // 4-byte emoji × 80k = ~320 KB UTF-8 but ~160k code units (each emoji
    // is 2 code units), well under the 256 Ki code-unit threshold.
    const fatEmojiText = "\u{1F600}".repeat(80_000);
    h.emitLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notify",
        params: { content: [{ kind: "text", text: fatEmojiText }] },
      }),
    );
    h.emitLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notify",
        params: { content: [{ kind: "text", text: "ok" }] },
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    expect((received[0]?.content[0] as TextBlock | undefined)?.text).toBe("ok");
    await ch.disconnect();
  });
});
