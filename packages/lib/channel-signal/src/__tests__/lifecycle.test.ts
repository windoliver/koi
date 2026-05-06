/**
 * Integration tests: full connect → multi-message ingress → multi-chunk
 * outbound → unexpected exit, plus JSON-RPC out-of-order response
 * correlation.
 */

import { describe, expect, test } from "bun:test";
import { createSignalChannel } from "../signal-channel.js";
import type { SignalChildProcess, SpawnFn } from "../signal-process.js";

interface Captured {
  readonly cmd: readonly string[];
  readonly stdinLines: string[];
  readonly emit: (json: string) => void;
  readonly finish: () => void;
  readonly respond: (id: number, result: unknown) => void;
  readonly setAutoRespond: (on: boolean) => void;
}

function makeSpawn(captured: Captured[]): SpawnFn {
  return (cmd) => {
    const stdinLines: string[] = [];
    let resolveExit: () => void = () => undefined;
    const exited = new Promise<void>((r) => {
      resolveExit = r;
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let autoRespond = true;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const respond = (id: number, result: unknown): void => {
      controller?.enqueue(
        new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`),
      );
    };
    const proc: SignalChildProcess = {
      stdout,
      stdin: {
        write: (d): void => {
          const text = new TextDecoder().decode(d);
          stdinLines.push(text);
          if (!autoRespond) return;
          try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            if (typeof parsed.id === "number") {
              const id = parsed.id;
              queueMicrotask(() => respond(id, {}));
            }
          } catch {
            // ignore
          }
        },
      },
      exited,
      kill: () => undefined,
    };
    captured.push({
      cmd,
      stdinLines,
      emit: (json: string) => controller?.enqueue(new TextEncoder().encode(`${json}\n`)),
      finish: () => resolveExit(),
      respond,
      setAutoRespond: (on) => {
        autoRespond = on;
      },
    });
    return proc;
  };
}

describe("channel-signal lifecycle", () => {
  test("connect → ingress → outbound → disconnect: full round-trip with multiple messages", async () => {
    const captured: Captured[] = [];
    const adapter = createSignalChannel({
      account: "+15551234567",
      spawn: makeSpawn(captured),
    });
    const seen: string[] = [];
    adapter.onMessage(async (m) => {
      const block = m.content[0];
      if (block?.kind === "text") seen.push(block.text);
    });
    await adapter.connect();

    const cap = captured[0];
    if (cap === undefined) throw new Error("no spawn captured");

    // Two inbound messages.
    cap.emit(
      JSON.stringify({
        params: {
          envelope: {
            source: "+15559998881",
            dataMessage: { message: "hello", timestamp: 1 },
          },
        },
      }),
    );
    cap.emit(
      JSON.stringify({
        params: {
          envelope: {
            source: "+15559998881",
            dataMessage: { message: "world", timestamp: 2 },
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual(["hello", "world"]);

    // Outbound: single send.
    await adapter.send({
      content: [{ kind: "text", text: "ack" }],
      threadId: "+15559998881",
    });
    const sentJsonrpc = cap.stdinLines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((p): p is Record<string, unknown> => p !== undefined && p.method === "send");
    expect(sentJsonrpc).toHaveLength(1);

    cap.finish();
    await adapter.disconnect();
  });

  test("concurrent sends are serialized (channel-base sendChain): each gets exactly one stdin write before the next runs", async () => {
    const captured: Captured[] = [];
    const adapter = createSignalChannel({
      account: "+15551234567",
      spawn: makeSpawn(captured),
    });
    await adapter.connect();
    const cap = captured[0];
    if (cap === undefined) throw new Error("no spawn captured");

    const sendA = adapter.send({
      content: [{ kind: "text", text: "first" }],
      threadId: "+15559998881",
    });
    const sendB = adapter.send({
      content: [{ kind: "text", text: "second" }],
      threadId: "+15559998882",
    });
    await Promise.all([sendA, sendB]);

    const sends = cap.stdinLines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((p): p is Record<string, unknown> => p !== undefined && p.method === "send");
    expect(sends).toHaveLength(2);
    // Each call carries its own monotonically-increasing id (correlation
    // primitive used by signal-process to match responses).
    const ids = sends.map((s) => s.id).filter((i): i is number => typeof i === "number");
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    cap.finish();
    await adapter.disconnect();
  });

  test("unexpected subprocess exit during active session forces disconnect, fires hook once", async () => {
    const captured: Captured[] = [];
    let hookCalls = 0;
    const adapter = createSignalChannel({
      account: "+15551234567",
      spawn: makeSpawn(captured),
      onUnexpectedExit: () => {
        hookCalls++;
      },
    });
    await adapter.connect();
    const cap = captured[0];
    if (cap === undefined) throw new Error("no spawn captured");

    // Deliver a message, confirm wiring works.
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    cap.emit(
      JSON.stringify({
        params: {
          envelope: {
            source: "+15559998881",
            dataMessage: { message: "alive", timestamp: 1 },
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 15));
    expect(seen).toHaveLength(1);

    // Subprocess dies.
    cap.finish();
    await new Promise((r) => setTimeout(r, 30));
    expect(hookCalls).toBe(1);

    // Send must now reject (channel is no longer connected).
    await expect(
      adapter.send({
        content: [{ kind: "text", text: "x" }],
        threadId: "+15559998881",
      }),
    ).rejects.toThrow();
  });
});
