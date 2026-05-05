import { describe, expect, test } from "bun:test";
import {
  createSignalProcess,
  parseEvent,
  type SignalChildProcess,
  type SignalEvent,
  type SpawnFn,
} from "./signal-process.js";

interface FakeProc {
  readonly proc: SignalChildProcess;
  readonly stdinChunks: string[];
  readonly killSignals: number[];
  emit: (line: string) => void;
  finishExit: () => void;
}

function makeFake(): FakeProc {
  const stdinChunks: string[] = [];
  const killSignals: number[] = [];
  let resolveExit: () => void = () => undefined;
  const exited = new Promise<void>((r) => {
    resolveExit = r;
  });
  // let requires justification: stream controller exposed for emit() helper
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start(c): void {
      controller = c;
    },
  });
  const proc: SignalChildProcess = {
    stdout,
    stdin: {
      write: (data: Uint8Array): void => {
        stdinChunks.push(new TextDecoder().decode(data));
      },
    },
    exited,
    kill: (signal?: number): void => {
      killSignals.push(signal ?? 15);
    },
  };
  return {
    proc,
    stdinChunks,
    killSignals,
    emit: (line) => {
      controller?.enqueue(new TextEncoder().encode(`${line}\n`));
    },
    finishExit: () => {
      resolveExit();
    },
  };
}

describe("@koi/channel-signal parseEvent", () => {
  test("parses dataMessage envelope", () => {
    const json = {
      params: {
        envelope: {
          source: "+15551234567",
          dataMessage: { message: "hello", timestamp: 1700000000 },
        },
      },
    };
    const ev = parseEvent(json);
    expect(ev?.kind).toBe("message");
    if (ev?.kind === "message") {
      expect(ev.body).toBe("hello");
      expect(ev.source).toBe("+15551234567");
    }
  });

  test("extracts groupId from groupInfo", () => {
    const json = {
      params: {
        envelope: {
          source: "+15551234567",
          dataMessage: { message: "hi", timestamp: 1, groupInfo: { groupId: "g==" } },
        },
      },
    };
    const ev = parseEvent(json);
    expect(ev?.kind).toBe("message");
    if (ev?.kind === "message") expect(ev.groupId).toBe("g==");
  });

  test("recognises receipt events", () => {
    const ev = parseEvent({
      params: { envelope: { source: "+15551234567", receiptMessage: {} } },
    });
    expect(ev?.kind).toBe("receipt");
  });

  test("recognises typing events", () => {
    const ev = parseEvent({
      params: {
        envelope: { source: "+15551234567", typingMessage: { action: "STARTED" } },
      },
    });
    expect(ev?.kind).toBe("typing");
    if (ev?.kind === "typing") expect(ev.started).toBe(true);
  });

  test("returns null for unknown shapes", () => {
    expect(parseEvent({ jsonrpc: "2.0", id: 1, result: {} })).toBeNull();
    expect(parseEvent("not an object")).toBeNull();
  });
});

describe("@koi/channel-signal createSignalProcess", () => {
  test("start() spawns signal-cli with -a and jsonRpc args", async () => {
    const f = makeFake();
    const calls: (readonly string[])[] = [];
    const spawn: SpawnFn = (cmd) => {
      calls.push(cmd);
      return f.proc;
    };
    const p = createSignalProcess("+15551234567", "/bin/signal-cli", undefined, spawn);
    await p.start();
    expect(calls[0]).toEqual(["/bin/signal-cli", "-a", "+15551234567", "jsonRpc"]);
    f.finishExit();
    await p.stop();
  });

  test("configPath is forwarded as --config", async () => {
    const f = makeFake();
    const calls: (readonly string[])[] = [];
    const spawn: SpawnFn = (cmd) => {
      calls.push(cmd);
      return f.proc;
    };
    const p = createSignalProcess("+15551234567", "signal-cli", "/etc/sig", spawn);
    await p.start();
    expect(calls[0]).toEqual([
      "signal-cli",
      "-a",
      "+15551234567",
      "--config",
      "/etc/sig",
      "jsonRpc",
    ]);
    f.finishExit();
    await p.stop();
  });

  test("stdout JSON lines are parsed and dispatched to onEvent handler", async () => {
    const f = makeFake();
    const spawn: SpawnFn = () => f.proc;
    const p = createSignalProcess("+15551234567", "signal-cli", undefined, spawn);
    const seen: SignalEvent[] = [];
    p.onEvent((e) => seen.push(e));
    await p.start();
    f.emit(
      JSON.stringify({
        params: {
          envelope: {
            source: "+15551234567",
            dataMessage: { message: "hi", timestamp: 1 },
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("message");
    f.finishExit();
    await p.stop();
  });

  test("stop() sends SIGTERM, then SIGKILL after timeout", async () => {
    const f = makeFake();
    const spawn: SpawnFn = () => f.proc;
    const p = createSignalProcess("+15551234567", "signal-cli", undefined, spawn, 5);
    await p.start();
    await p.stop();
    expect(f.killSignals[0]).toBe(15);
    expect(f.killSignals[1]).toBe(9);
  });

  test("send() throws when not running", async () => {
    const f = makeFake();
    const spawn: SpawnFn = () => f.proc;
    const p = createSignalProcess("+15551234567", "signal-cli", undefined, spawn);
    await expect(p.send({ method: "send", params: { recipient: "+15551234567" } })).rejects.toThrow(
      /not running/,
    );
  });

  test("send() writes a JSON-RPC line to stdin", async () => {
    const f = makeFake();
    const spawn: SpawnFn = () => f.proc;
    const p = createSignalProcess("+15551234567", "signal-cli", undefined, spawn);
    await p.start();
    await p.send({ method: "send", params: { recipient: "+15551234567", message: "hi" } });
    expect(f.stdinChunks).toHaveLength(1);
    const parsed = JSON.parse(f.stdinChunks[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("send");
    f.finishExit();
    await p.stop();
  });

  test("subprocess exiting unexpectedly flips running false and fires onUnexpectedExit", async () => {
    const f = makeFake();
    const spawn: SpawnFn = () => f.proc;
    let died = 0;
    const p = createSignalProcess(
      "+15551234567",
      "signal-cli",
      undefined,
      spawn,
      undefined,
      () => died++,
    );
    await p.start();
    expect(p.isRunning()).toBe(true);
    f.finishExit();
    await new Promise((r) => setTimeout(r, 10));
    expect(p.isRunning()).toBe(false);
    expect(died).toBe(1);
    await expect(p.send({ method: "send", params: { recipient: "+1" } })).rejects.toThrow(
      /not running/,
    );
  });

  test("isRunning reflects start/stop", async () => {
    const f = makeFake();
    const spawn: SpawnFn = () => f.proc;
    const p = createSignalProcess("+15551234567", "signal-cli", undefined, spawn);
    expect(p.isRunning()).toBe(false);
    await p.start();
    expect(p.isRunning()).toBe(true);
    f.finishExit();
    await p.stop();
    expect(p.isRunning()).toBe(false);
  });
});
