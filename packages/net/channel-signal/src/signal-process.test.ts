import { describe, expect, mock, test } from "bun:test";
import type { SpawnFn } from "./config.js";
import { createSignalProcess } from "./signal-process.js";

/** Creates a mock spawn function with controllable stdout. */
function createMockSpawn(): {
  readonly spawn: SpawnFn;
  readonly pushLine: (line: string) => void;
  readonly kill: ReturnType<typeof mock>;
  readonly stdin: { readonly write: ReturnType<typeof mock> };
} {
  // let: resolve function for the exit promise
  let resolveExit: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  // Auto-resolve exited when kill is called
  const kill = mock(() => {
    resolveExit?.(0);
  });
  const stdinWrite = mock(() => 0);

  // Create a readable stream we can push data into
  // let: controller reference for pushing data
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const encoder = new TextEncoder();
  const pushLine = (line: string): void => {
    controller?.enqueue(encoder.encode(`${line}\n`));
  };

  const spawn: SpawnFn = mock(() => ({
    stdout,
    stdin: { write: stdinWrite },
    kill,
    exited,
  }));

  return {
    spawn,
    pushLine,
    kill,
    stdin: { write: stdinWrite },
  };
}

describe("createSignalProcess", () => {
  test("start spawns signal-cli with correct args", async () => {
    const { spawn } = createMockSpawn();
    const process = createSignalProcess("+1234567890", "signal-cli", undefined, spawn);
    await process.start();

    expect(spawn).toHaveBeenCalledTimes(1);
    const cmd = (spawn as ReturnType<typeof mock>).mock.calls[0]?.[0] as readonly string[];
    expect(cmd).toEqual(["signal-cli", "-a", "+1234567890", "jsonRpc"]);

    await process.stop();
  });

  test("start includes --config when configPath is provided", async () => {
    const { spawn } = createMockSpawn();
    const process = createSignalProcess("+1234567890", "signal-cli", "/etc/signal", spawn);
    await process.start();

    const cmd = (spawn as ReturnType<typeof mock>).mock.calls[0]?.[0] as readonly string[];
    expect(cmd).toContain("--config");
    expect(cmd).toContain("/etc/signal");

    await process.stop();
  });

  test("start is idempotent", async () => {
    const { spawn } = createMockSpawn();
    const process = createSignalProcess("+1234567890", "signal-cli", undefined, spawn);
    await process.start();
    await process.start();

    expect(spawn).toHaveBeenCalledTimes(1);
    await process.stop();
  });

  test("isRunning returns true after start", async () => {
    const { spawn } = createMockSpawn();
    const process = createSignalProcess("+1234567890", "signal-cli", undefined, spawn);
    expect(process.isRunning()).toBe(false);
    await process.start();
    expect(process.isRunning()).toBe(true);
    await process.stop();
    expect(process.isRunning()).toBe(false);
  });

  test("send writes JSON-RPC to stdin", async () => {
    const { spawn, stdin } = createMockSpawn();
    const process = createSignalProcess("+1234567890", "signal-cli", undefined, spawn);
    await process.start();

    await process.send({ method: "send", params: { message: "hello", recipient: "+9876543210" } });

    expect(stdin.write).toHaveBeenCalledTimes(1);
    const written = stdin.write.mock.calls[0]?.[0] as Uint8Array;
    const text = new TextDecoder().decode(written);
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("send");

    await process.stop();
  });

  test("send throws when process not running", async () => {
    const { spawn } = createMockSpawn();
    const process = createSignalProcess("+1234567890", "signal-cli", undefined, spawn);

    await expect(process.send({ method: "send", params: { message: "fail" } })).rejects.toThrow(
      "process not running",
    );
  });

  test("receives events from stdout", async () => {
    const { spawn, pushLine } = createMockSpawn();
    const process = createSignalProcess("+1234567890", "signal-cli", undefined, spawn);

    const received: unknown[] = [];
    process.onEvent((event) => {
      received.push(event);
    });

    await process.start();

    pushLine(
      JSON.stringify({
        params: {
          source: "+9876543210",
          dataMessage: {
            message: "hello from signal",
            timestamp: 1700000000000,
          },
        },
      }),
    );

    await Bun.sleep(50);

    expect(received).toHaveLength(1);
    const event = received[0] as Record<string, unknown>;
    expect(event.kind).toBe("message");
    expect(event.body).toBe("hello from signal");
    expect(event.source).toBe("+9876543210");

    await process.stop();
  });

  test("stop calls kill with SIGTERM", async () => {
    const { spawn, kill } = createMockSpawn();
    const process = createSignalProcess("+1234567890", "signal-cli", undefined, spawn);
    await process.start();
    await process.stop();

    expect(kill).toHaveBeenCalledWith(15);
  });
});
