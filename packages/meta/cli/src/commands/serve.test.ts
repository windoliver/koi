import { describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EngineEvent, type EngineInput, runId } from "@koi/core";
import type { ServeFlags } from "../args/serve.js";
import { ExitCode } from "../types.js";
import { run } from "./serve.js";

const SECRET = "serve-test-secret";

describe("serve command", () => {
  test("starts HTTP ingress and routes signed frames into the runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "koi-serve-"));
    const manifest = join(dir, "koi.yaml");
    await writeFile(
      manifest,
      ["name: Serve Agent", "model:", "  name: openai:gpt-test"].join("\n"),
    );

    const prevSecret = process.env.KOI_GATEWAY_SECRET;
    const prevChannel = process.env.KOI_GATEWAY_CHANNEL;
    const prevReplay = process.env.KOI_GATEWAY_REPLAY;
    const prevState = process.env.KOI_STATE_DIR;
    process.env.KOI_GATEWAY_SECRET = SECRET;
    process.env.KOI_GATEWAY_CHANNEL = "test";
    process.env.KOI_GATEWAY_REPLAY = "timestamp";
    process.env.KOI_STATE_DIR = join(dir, "state");

    let resolveShutdown: ((signal: string) => void) | undefined;
    const shutdown = new Promise<string>((resolve) => {
      resolveShutdown = resolve;
    });
    const started = deferred<StartedEvent>();
    const stdout = spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            const event = JSON.parse(trimmed) as StartedEvent;
            if (event.kind === "serve_started") started.resolve(event);
          } catch {
            // Ignore non-JSON fragments from unrelated diagnostics.
          }
        }
        return true;
      },
    );
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

    const inputs: EngineInput[] = [];
    let disposed = 0;
    const runPromise = run(
      {
        command: "serve",
        version: false,
        help: false,
        manifest,
        port: 0,
        verbose: false,
        logFormat: "json",
      } satisfies ServeFlags,
      {
        waitForShutdownSignal: () => shutdown,
        createRuntime: async () => ({
          runtime: {
            run: (input: EngineInput) => {
              inputs.push(input);
              return runHandle(singleEvent(doneEvent()));
            },
            dispose: async () => {
              disposed++;
            },
          },
          shutdownBackgroundTasks: () => false,
        }),
      },
    );

    try {
      const event = await withTimeout(started.promise, 2_000);
      const body = JSON.stringify({ event_id: "evt-1", team_id: "tenant-1", text: "hello" });
      const response = await fetch(`http://127.0.0.1:${event.port}/webhooks/test/T1`, {
        method: "POST",
        headers: signedHeaders(body),
        body,
      });

      expect(response.status).toBe(200);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.kind).toBe("messages");
      if (inputs[0]?.kind !== "messages") throw new Error("expected messages input");
      expect(inputs[0].messages[0]?.content).toEqual([{ kind: "text", text: "hello" }]);

      resolveShutdown?.("test");
      expect(await runPromise).toBe(ExitCode.OK);
      expect(disposed).toBe(1);
    } finally {
      resolveShutdown?.("cleanup");
      await runPromise.catch(() => ExitCode.FAILURE);
      stdout.mockRestore();
      stderr.mockRestore();
      restoreEnv("KOI_GATEWAY_SECRET", prevSecret);
      restoreEnv("KOI_GATEWAY_CHANNEL", prevChannel);
      restoreEnv("KOI_GATEWAY_REPLAY", prevReplay);
      restoreEnv("KOI_STATE_DIR", prevState);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails closed when no gateway secret is configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "koi-serve-no-secret-"));
    const manifest = join(dir, "koi.yaml");
    await writeFile(
      manifest,
      ["name: Serve Agent", "model:", "  name: openai:gpt-test"].join("\n"),
    );

    const prevSecret = process.env.KOI_GATEWAY_SECRET;
    const prevState = process.env.KOI_STATE_DIR;
    delete process.env.KOI_GATEWAY_SECRET;
    process.env.KOI_STATE_DIR = join(dir, "state");

    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    let disposed = 0;
    try {
      const exitCode = await run(
        {
          command: "serve",
          version: false,
          help: false,
          manifest,
          port: 0,
          verbose: false,
          logFormat: "text",
        } satisfies ServeFlags,
        {
          waitForShutdownSignal: async () => "unused",
          createRuntime: async () => ({
            runtime: {
              run: () => runHandle(singleEvent(doneEvent())),
              dispose: async () => {
                disposed++;
              },
            },
            shutdownBackgroundTasks: () => false,
          }),
        },
      );

      expect(exitCode).toBe(ExitCode.FAILURE);
      expect(disposed).toBe(1);
    } finally {
      stderr.mockRestore();
      restoreEnv("KOI_GATEWAY_SECRET", prevSecret);
      restoreEnv("KOI_STATE_DIR", prevState);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

interface StartedEvent {
  readonly kind: "serve_started";
  readonly port: number;
}

function signedHeaders(body: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const hmac = createHmac("sha256", SECRET);
  hmac.update(`v0:${timestamp}:${body}`);
  return {
    "Content-Type": "application/json",
    "X-Webhook-Timestamp": timestamp,
    "X-Webhook-Signature": `v0=${hmac.digest("hex")}`,
  };
}

function doneEvent(): EngineEvent {
  return {
    kind: "done",
    output: {
      content: [],
      stopReason: "completed",
      metrics: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        turns: 1,
        durationMs: 0,
      },
    },
  };
}

async function* singleEvent(event: EngineEvent): AsyncGenerator<EngineEvent> {
  yield event;
}

function runHandle(iterable: AsyncIterable<EngineEvent>) {
  return {
    runId: runId(crypto.randomUUID()),
    interrupt: () => false,
    [Symbol.asyncIterator]: () => iterable[Symbol.asyncIterator](),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
