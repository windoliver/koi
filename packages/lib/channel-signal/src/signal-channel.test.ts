import { describe, expect, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import { GROUP_THREAD_PREFIX } from "./normalize.js";
import { blocksToText, createSignalChannel, splitText } from "./signal-channel.js";
import type { SignalChildProcess, SpawnFn } from "./signal-process.js";

interface Captured {
  readonly cmd: readonly string[];
  readonly stdinLines: string[];
  readonly emit: (json: string) => void;
  readonly finish: () => void;
}

function makeSpawn(captured: Captured[]): SpawnFn {
  return (cmd) => {
    const stdinLines: string[] = [];
    let resolveExit: () => void = () => undefined;
    const exited = new Promise<void>((r) => {
      resolveExit = r;
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const proc: SignalChildProcess = {
      stdout,
      stdin: { write: (d) => stdinLines.push(new TextDecoder().decode(d)) },
      exited,
      kill: () => undefined,
    };
    captured.push({
      cmd,
      stdinLines,
      emit: (json: string) => controller?.enqueue(new TextEncoder().encode(`${json}\n`)),
      finish: () => resolveExit(),
    });
    return proc;
  };
}

describe("@koi/channel-signal createSignalChannel", () => {
  test("rejects non-E.164 account at construction", () => {
    expect(() =>
      createSignalChannel({ account: "not-a-number", spawn: () => ({}) as never }),
    ).toThrow(/E.164/);
  });

  test("falls back to defaultSignalSpawn when config.spawn is omitted", () => {
    // Default uses Bun.spawn — we don't actually call connect() here, so no
    // signal-cli binary is required. This just asserts construction works.
    const adapter = createSignalChannel({ account: "+15551234567" });
    expect(adapter.name).toBe("signal");
  });

  test("connect drives signal-cli subprocess with the configured account", async () => {
    const captured: Captured[] = [];
    const adapter = createSignalChannel({
      account: "+15551234567",
      signalCliPath: "/usr/bin/signal-cli",
      spawn: makeSpawn(captured),
    });
    await adapter.connect();
    expect(captured[0]?.cmd).toEqual(["/usr/bin/signal-cli", "-a", "+15551234567", "jsonRpc"]);
    captured[0]?.finish();
    await adapter.disconnect();
  });

  test("inbound dataMessage becomes an InboundMessage", async () => {
    const captured: Captured[] = [];
    const adapter = createSignalChannel({
      account: "+15551234567",
      spawn: makeSpawn(captured),
    });
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    await adapter.connect();
    captured[0]?.emit(
      JSON.stringify({
        params: {
          envelope: {
            source: "+15559998888",
            dataMessage: { message: "hi", timestamp: 1700000000000 },
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toHaveLength(1);
    captured[0]?.finish();
    await adapter.disconnect();
  });

  test("send to DM produces send + recipient JSON-RPC", async () => {
    const captured: Captured[] = [];
    const adapter = createSignalChannel({
      account: "+15551234567",
      spawn: makeSpawn(captured),
    });
    await adapter.connect();
    const out: OutboundMessage = {
      content: [{ kind: "text", text: "hello" }],
      threadId: "+15559998888",
    };
    await adapter.send(out);
    expect(captured[0]?.stdinLines).toHaveLength(1);
    const rpc = JSON.parse(captured[0]?.stdinLines[0] ?? "{}") as {
      readonly method: string;
      readonly params: {
        readonly recipient?: string;
        readonly groupId?: string;
        readonly message?: string;
      };
    };
    expect(rpc.method).toBe("send");
    expect(rpc.params.recipient).toBe("+15559998888");
    expect(rpc.params.groupId).toBeUndefined();
    expect(rpc.params.message).toBe("hello");
    captured[0]?.finish();
    await adapter.disconnect();
  });

  test("send to group produces send + groupId JSON-RPC", async () => {
    const captured: Captured[] = [];
    const adapter = createSignalChannel({
      account: "+15551234567",
      spawn: makeSpawn(captured),
    });
    await adapter.connect();
    await adapter.send({
      content: [{ kind: "text", text: "hi" }],
      threadId: `${GROUP_THREAD_PREFIX}grp123`,
    });
    const rpc = JSON.parse(captured[0]?.stdinLines[0] ?? "{}") as {
      readonly params: { readonly groupId?: string; readonly recipient?: string };
    };
    expect(rpc.params.groupId).toBe("grp123");
    expect(rpc.params.recipient).toBeUndefined();
    captured[0]?.finish();
    await adapter.disconnect();
  });

  test("send: DM threadId not in E.164 form throws", async () => {
    const captured: Captured[] = [];
    const adapter = createSignalChannel({
      account: "+15551234567",
      spawn: makeSpawn(captured),
    });
    await adapter.connect();
    await expect(
      adapter.send({ content: [{ kind: "text", text: "x" }], threadId: "garbage" }),
    ).rejects.toThrow(/E\.164/);
    captured[0]?.finish();
    await adapter.disconnect();
  });

  test("send: missing threadId throws", async () => {
    const captured: Captured[] = [];
    const adapter = createSignalChannel({
      account: "+15551234567",
      spawn: makeSpawn(captured),
    });
    await adapter.connect();
    await expect(adapter.send({ content: [{ kind: "text", text: "x" }] })).rejects.toThrow(
      /threadId is required/,
    );
    captured[0]?.finish();
    await adapter.disconnect();
  });

  test("send: long body splits into multiple JSON-RPC calls", async () => {
    const captured: Captured[] = [];
    const adapter = createSignalChannel({
      account: "+15551234567",
      spawn: makeSpawn(captured),
    });
    await adapter.connect();
    const big = "x".repeat(8500);
    await adapter.send({
      content: [{ kind: "text", text: big }],
      threadId: "+15559998888",
    });
    expect(captured[0]?.stdinLines.length).toBeGreaterThanOrEqual(3);
    captured[0]?.finish();
    await adapter.disconnect();
  });

  test("send: empty body is a no-op", async () => {
    const captured: Captured[] = [];
    const adapter = createSignalChannel({
      account: "+15551234567",
      spawn: makeSpawn(captured),
    });
    await adapter.connect();
    await adapter.send({
      content: [{ kind: "custom", type: "x", data: 1 }],
      threadId: "+15559998888",
    });
    expect(captured[0]?.stdinLines).toHaveLength(0);
    captured[0]?.finish();
    await adapter.disconnect();
  });
});

describe("blocksToText", () => {
  test("text blocks join with newlines", () => {
    expect(
      blocksToText([
        { kind: "text", text: "a" },
        { kind: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });
  test("non-text blocks become bracketed hints", () => {
    expect(
      blocksToText([
        { kind: "image", url: "u", alt: "cat" },
        { kind: "file", url: "u", mimeType: "x", name: "f.pdf" },
        { kind: "button", label: "OK", action: "ok" },
      ]),
    ).toBe("[Image: cat]\n[File: f.pdf]\n[OK]");
  });
});

describe("splitText", () => {
  test("returns input unchanged when below limit", () => {
    expect(splitText("abc", 100)).toEqual(["abc"]);
  });
});
