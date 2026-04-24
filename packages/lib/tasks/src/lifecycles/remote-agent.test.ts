/**
 * createRemoteAgentLifecycle tests — TDD spec for the remote_agent task kind.
 *
 * Protocol: POST to endpoint with { correlationId, payload }.
 * Response: NDJSON stream — { kind: "chunk", text } or { kind: "done", exitCode }.
 */

import { describe, expect, mock, test } from "bun:test";
import { taskItemId } from "@koi/core";
import { createOutputStream } from "../output-stream.js";
import type { RemoteAgentConfig, RemoteAgentLifecycleOptions } from "./remote-agent.js";
import { createRemoteAgentLifecycle } from "./remote-agent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tid(n = 1): ReturnType<typeof taskItemId> {
  return taskItemId(`task-${String(n)}`);
}

type NdjsonFrame =
  | { readonly kind: "chunk"; readonly text: string }
  | { readonly kind: "done"; readonly exitCode: number };

function makeNdjsonStream(...frames: NdjsonFrame[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const ndjson = `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(ndjson));
      controller.close();
    },
  });
}

function makeNdjsonStreamChunked(
  frames: NdjsonFrame[],
  chunkSize: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const ndjson = `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`;
  const bytes = encoder.encode(ndjson);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

function mockFetch(status: number, body: ReadableStream<Uint8Array>): typeof globalThis.fetch {
  return mock(async (_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(body, { status })),
  ) as unknown as typeof globalThis.fetch;
}

function errorFetch(err: Error): typeof globalThis.fetch {
  return mock(async (_url: string | URL | Request, _init?: RequestInit) =>
    Promise.reject(err),
  ) as unknown as typeof globalThis.fetch;
}

const FAST_OPTIONS: RemoteAgentLifecycleOptions = { drainTimeoutMs: 50 };

function makeConfig(overrides: Partial<RemoteAgentConfig> = {}): RemoteAgentConfig {
  return {
    endpoint: "http://agent.internal/run",
    correlationId: "corr-abc",
    payload: { task: "hello" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRemoteAgentLifecycle", () => {
  describe("happy path — streams chunks and exits 0", () => {
    test("writes chunk text to output", async () => {
      const fetch = mockFetch(
        200,
        makeNdjsonStream(
          { kind: "chunk", text: "hello " },
          { kind: "chunk", text: "world" },
          { kind: "done", exitCode: 0 },
        ),
      );
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();
      const id = tid();

      const state = await lifecycle.start(id, output, makeConfig());
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (output.length() >= 2) {
            clearInterval(interval);
            resolve();
          }
        }, 10);
      });

      const chunks = output.read(0);
      const text = chunks.map((c) => c.content).join("");
      expect(text).toContain("hello world");
      expect(state.kind).toBe("remote_agent");
      expect(state.endpoint).toBe("http://agent.internal/run");
      expect(state.correlationId).toBe("corr-abc");
    });

    test("fires onExit(0) on done frame with exitCode 0", async () => {
      const exits: number[] = [];
      const fetch = mockFetch(200, makeNdjsonStream({ kind: "done", exitCode: 0 }));
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      await lifecycle.start(
        tid(),
        output,
        makeConfig({
          onExit: (code) => {
            exits.push(code);
          },
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(exits).toEqual([0]);
    });

    test("fires onExit(code) matching server exitCode on non-zero done", async () => {
      const exits: number[] = [];
      const fetch = mockFetch(200, makeNdjsonStream({ kind: "done", exitCode: 42 }));
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      await lifecycle.start(
        tid(),
        output,
        makeConfig({
          onExit: (code) => {
            exits.push(code);
          },
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(exits).toEqual([42]);
    });

    test("fails with protocol error when stream ends without done frame", async () => {
      const exits: number[] = [];
      const fetch = mockFetch(200, makeNdjsonStream({ kind: "chunk", text: "partial" }));
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      await lifecycle.start(
        tid(),
        output,
        makeConfig({
          onExit: (code) => {
            exits.push(code);
          },
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const text = output
        .read(0)
        .map((c) => c.content)
        .join("");
      expect(text).toContain("protocol error");
      expect(exits).toEqual([1]);
    });

    test("fails with protocol error on null response body", async () => {
      const exits: number[] = [];
      const fetchNull: typeof globalThis.fetch = mock(
        async (_url: string | URL | Request, _init?: RequestInit) =>
          Promise.resolve(new Response(null, { status: 200 })),
      ) as unknown as typeof globalThis.fetch;
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch: fetchNull });
      const output = createOutputStream();

      await lifecycle.start(
        tid(),
        output,
        makeConfig({
          onExit: (code) => {
            exits.push(code);
          },
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const text = output
        .read(0)
        .map((c) => c.content)
        .join("");
      expect(text).toContain("protocol error");
      expect(exits).toEqual([1]);
    });

    test("fails with protocol error on malformed JSON frame", async () => {
      const exits: number[] = [];
      const encoder = new TextEncoder();
      const badStream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode("not-json\n"));
          c.close();
        },
      });
      const fetch = mockFetch(200, badStream);
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      await lifecycle.start(
        tid(),
        output,
        makeConfig({
          onExit: (code) => {
            exits.push(code);
          },
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const text = output
        .read(0)
        .map((c) => c.content)
        .join("");
      expect(text).toContain("protocol error");
      expect(exits).toEqual([1]);
    });

    test("sends correct POST body and headers", async () => {
      let capturedInit: RequestInit | undefined;
      const fetchSpy: typeof globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          capturedInit = init;
          return new Response(makeNdjsonStream({ kind: "done", exitCode: 0 }), { status: 200 });
        },
      ) as unknown as typeof globalThis.fetch;

      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch: fetchSpy });
      const output = createOutputStream();

      await lifecycle.start(
        tid(),
        output,
        makeConfig({
          headers: { Authorization: "Bearer tok" },
          payload: { x: 1 },
          correlationId: "cid-99",
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(capturedInit?.method).toBe("POST");
      const body = JSON.parse(capturedInit?.body as string) as unknown;
      expect(body).toEqual({ correlationId: "cid-99", payload: { x: 1 } });
      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers.Authorization).toBe("Bearer tok");
    });

    test("handles done frame with no trailing newline (buffer remainder)", async () => {
      const exits: number[] = [];
      const encoder = new TextEncoder();
      // No trailing \n after done frame
      const noNewlineStream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode('{"kind":"done","exitCode":0}'));
          c.close();
        },
      });
      const fetch = mockFetch(200, noNewlineStream);
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      await lifecycle.start(
        tid(),
        output,
        makeConfig({
          onExit: (code) => {
            exits.push(code);
          },
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(exits).toEqual([0]);
    });

    test("handles NDJSON split across read() boundaries (chunked transport)", async () => {
      const exits: number[] = [];
      const fetch = mockFetch(
        200,
        makeNdjsonStreamChunked(
          [
            { kind: "chunk", text: "a" },
            { kind: "chunk", text: "b" },
            { kind: "done", exitCode: 0 },
          ],
          3, // small chunks to force boundary splits
        ),
      );
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      await lifecycle.start(
        tid(),
        output,
        makeConfig({
          onExit: (code) => {
            exits.push(code);
          },
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      const text = output
        .read(0)
        .map((c) => c.content)
        .join("");
      expect(text).toContain("a");
      expect(text).toContain("b");
      expect(exits).toEqual([0]);
    });
  });

  describe("HTTP error responses", () => {
    test("writes error message and fires onExit(1) on non-2xx status", async () => {
      const exits: number[] = [];
      const fetch = mockFetch(503, new ReadableStream());
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      await lifecycle.start(
        tid(),
        output,
        makeConfig({
          onExit: (code) => {
            exits.push(code);
          },
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      const text = output
        .read(0)
        .map((c) => c.content)
        .join("");
      expect(text).toContain("503");
      expect(exits).toEqual([1]);
    });

    test("writes error message and fires onExit(1) on 404", async () => {
      const exits: number[] = [];
      const fetch = mockFetch(404, new ReadableStream());
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      await lifecycle.start(
        tid(),
        output,
        makeConfig({
          onExit: (code) => {
            exits.push(code);
          },
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(exits).toEqual([1]);
    });
  });

  describe("network errors", () => {
    test("writes error message and fires onExit(1) on fetch rejection", async () => {
      const exits: number[] = [];
      const fetch = errorFetch(new Error("ECONNREFUSED"));
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      await lifecycle.start(
        tid(),
        output,
        makeConfig({
          onExit: (code) => {
            exits.push(code);
          },
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      const text = output
        .read(0)
        .map((c) => c.content)
        .join("");
      expect(text).toContain("ECONNREFUSED");
      expect(exits).toEqual([1]);
    });
  });

  describe("cancel", () => {
    test("cancel() aborts in-flight fetch — onExit is NOT called", async () => {
      const exits: number[] = [];
      // Slow stream: never sends done
      const encoder = new TextEncoder();
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      const slowStream = new ReadableStream<Uint8Array>({
        start(c) {
          controllerRef = c;
        },
      });
      const fetch = mockFetch(200, slowStream);
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      const state = await lifecycle.start(
        tid(),
        output,
        makeConfig({
          onExit: (code) => {
            exits.push(code);
          },
        }),
      );

      // Send a chunk then cancel mid-stream
      controllerRef?.enqueue(encoder.encode(`${JSON.stringify({ kind: "chunk", text: "x" })}\n`));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      state.cancel();

      await lifecycle.stop(state);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // onExit must NOT be called on explicit cancel — remote termination unconfirmed
      expect(exits).toEqual([]);
      // cleanup-incomplete marker must be written to surface the uncertain state
      const text = output
        .read(0)
        .map((c) => c.content)
        .join("");
      expect(text).toContain("cleanup-incomplete");
    });

    test("stop() resolves without error after cancel", async () => {
      const slowStream = new ReadableStream<Uint8Array>({ start() {} });
      const fetch = mockFetch(200, slowStream);
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      const state = await lifecycle.start(tid(), output, makeConfig());

      await expect(lifecycle.stop(state)).resolves.toBeUndefined();
    });
  });

  describe("timeout", () => {
    test("writes cleanup-incomplete marker on timeout — onExit NOT called", async () => {
      const exits: number[] = [];
      const slowStream = new ReadableStream<Uint8Array>({ start() {} });
      const fetch = mockFetch(200, slowStream);
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      await lifecycle.start(
        tid(),
        output,
        makeConfig({
          timeout: 80,
          onExit: (code) => {
            exits.push(code);
          },
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 300));

      const text = output
        .read(0)
        .map((c) => c.content)
        .join("");
      // Timeout cannot confirm remote stopped — must emit cleanup-incomplete, not success
      expect(text).toContain("timed out");
      expect(text).toContain("remote agent may still be running");
      // onExit must NOT be called on timeout — remote termination unconfirmed
      expect(exits).toEqual([]);
    });

    test("onExit is called at most once even on timeout + natural exit race", async () => {
      const exits: number[] = [];
      const fetch = mockFetch(200, makeNdjsonStream({ kind: "done", exitCode: 0 }));
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      // timeout much longer than stream — natural exit wins
      await lifecycle.start(
        tid(),
        output,
        makeConfig({
          timeout: 5000,
          onExit: (code) => {
            exits.push(code);
          },
        }),
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(exits).toHaveLength(1);
      expect(exits[0]).toBe(0);
    });
  });

  describe("throwing onExit", () => {
    test("throwing onExit does not crash the lifecycle", async () => {
      const fetch = mockFetch(200, makeNdjsonStream({ kind: "done", exitCode: 0 }));
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      await expect(
        lifecycle.start(
          tid(),
          output,
          makeConfig({
            onExit: () => {
              throw new Error("boom");
            },
          }),
        ),
      ).resolves.toBeDefined();

      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      // No unhandled rejection — test passes if we reach here
    });
  });

  describe("kind and registry contract", () => {
    test("lifecycle.kind is remote_agent", () => {
      const lifecycle = createRemoteAgentLifecycle(FAST_OPTIONS);
      expect(lifecycle.kind).toBe("remote_agent");
    });

    test("returned state has expected shape", async () => {
      const fetch = mockFetch(200, makeNdjsonStream({ kind: "done", exitCode: 0 }));
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      const state = await lifecycle.start(
        tid(),
        output,
        makeConfig({ endpoint: "http://ep/x", correlationId: "cid" }),
      );

      expect(state.kind).toBe("remote_agent");
      expect(state.endpoint).toBe("http://ep/x");
      expect(state.correlationId).toBe("cid");
      expect(typeof state.cancel).toBe("function");
      expect(typeof state.startedAt).toBe("number");
    });
  });
});
