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

const TEST_ENDPOINT = "http://agent.internal/run";
const FAST_OPTIONS: RemoteAgentLifecycleOptions = { endpoint: TEST_ENDPOINT, drainTimeoutMs: 50 };

function makeConfig(overrides: Partial<RemoteAgentConfig> = {}): RemoteAgentConfig {
  return {
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

    test("stops reading after done frame — post-done chunks are not written", async () => {
      const exits: number[] = [];
      const fetch = mockFetch(
        200,
        makeNdjsonStream(
          { kind: "chunk", text: "before" },
          { kind: "done", exitCode: 0 },
          { kind: "chunk", text: "after-done" }, // must not appear in output
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

      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const text = output
        .read(0)
        .map((c) => c.content)
        .join("");
      expect(text).toContain("before");
      expect(text).not.toContain("after-done");
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
    test("calls onExit(1) on timeout and writes cleanup-incomplete detail", async () => {
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
      // Timeout emits cleanup-incomplete detail so callers know remote may still be running
      expect(text).toContain("timed out");
      expect(text).toContain("remote agent may still be running");
      // onExit(1) IS called so TaskRunner can fail the task on the board
      expect(exits).toEqual([1]);
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
      const output = createOutputStream();

      const lifecycle2 = createRemoteAgentLifecycle({
        ...FAST_OPTIONS,
        endpoint: "http://ep/x",
        fetch,
      });
      const state = await lifecycle2.start(tid(), output, makeConfig({ correlationId: "cid" }));

      expect(state.kind).toBe("remote_agent");
      expect(state.endpoint).toBe("http://ep/x");
      expect(state.correlationId).toBe("cid");
      expect(typeof state.cancel).toBe("function");
      expect(typeof state.startedAt).toBe("number");
    });
  });

  describe("UTF-8 boundary handling", () => {
    test("multibyte character split across final chunk is decoded correctly", async () => {
      // "café" — the é (U+00E9) encodes to 0xC3 0xA9 in UTF-8.
      // Split the stream so the last byte of é lands in the tail buffer flush.
      const encoder = new TextEncoder();
      const doneFrame = JSON.stringify({ kind: "done", exitCode: 0 });
      const chunkFrame = JSON.stringify({ kind: "chunk", text: "café" });
      const ndjson = encoder.encode(`${chunkFrame}\n${doneFrame}\n`);
      // Split after the first byte of é so the second byte is in the next chunk
      const split = ndjson.indexOf(0xc3) + 1; // 0xC3 is first byte of é
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(ndjson.slice(0, split));
          controller.enqueue(ndjson.slice(split));
          controller.close();
        },
      });
      const fetch = mock(async () =>
        Promise.resolve(new Response(stream, { status: 200 })),
      ) as unknown as typeof globalThis.fetch;
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      await lifecycle.start(tid(), output, makeConfig());
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
      expect(text).toContain("café");
      expect(text).toContain("[exit code: 0]");
    });
  });

  describe("transport close after done frame", () => {
    test("server that keeps streaming after done frame is ignored", async () => {
      // Stream: chunk → done → extra chunk after done (server misbehaves)
      const frames: NdjsonFrame[] = [
        { kind: "chunk", text: "hello" },
        { kind: "done", exitCode: 0 },
      ];
      // The extra post-done bytes are appended manually
      const encoder = new TextEncoder();
      const ndjson = `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`;
      const extraBytes = encoder.encode(`${JSON.stringify({ kind: "chunk", text: "EXTRA" })}\n`);
      const mainBytes = encoder.encode(ndjson);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(mainBytes);
          controller.enqueue(extraBytes);
          controller.close();
        },
      });
      const fetch = mock(async () =>
        Promise.resolve(new Response(stream, { status: 200 })),
      ) as unknown as typeof globalThis.fetch;
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch });
      const output = createOutputStream();

      await lifecycle.start(tid(), output, makeConfig());
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
      expect(text).toContain("hello");
      expect(text).not.toContain("EXTRA");
      expect(text).toContain("[exit code: 0]");
    });
  });

  describe("SSRF redirect protection", () => {
    test("redirect: error causes fetch error that is surfaced as lifecycle error", async () => {
      const exits: number[] = [];
      // Simulate what a real fetch does when redirect:"error" encounters a 3xx:
      // it rejects with a TypeError.
      const redirectFetch: typeof globalThis.fetch = mock(
        async (_url: string | URL | Request, _init?: RequestInit) =>
          Promise.reject(new TypeError("redirect was blocked")),
      ) as unknown as typeof globalThis.fetch;
      const lifecycle = createRemoteAgentLifecycle({ ...FAST_OPTIONS, fetch: redirectFetch });
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
      const text = output
        .read(0)
        .map((c) => c.content)
        .join("");
      expect(text).toContain("redirect was blocked");
    });
  });

  describe("max frame size guard", () => {
    test("many small frames coalesced into one large chunk still succeed", async () => {
      // Total chunk > 1 MiB, but each individual NDJSON line is small.
      // The guard must not trip on the combined buffer before line splitting.
      const encoder = new TextEncoder();
      const frames: NdjsonFrame[] = [];
      for (let i = 0; i < 5000; i++) {
        frames.push({ kind: "chunk", text: "a".repeat(200) }); // 200 bytes each → 1MB total
      }
      frames.push({ kind: "done", exitCode: 0 });
      // Deliver all frames in one ReadableStream chunk.
      const ndjson = `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(ndjson));
          controller.close();
        },
      });
      const fetch = mock(async () =>
        Promise.resolve(new Response(stream, { status: 200 })),
      ) as unknown as typeof globalThis.fetch;
      const exits: number[] = [];
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

      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      expect(exits).toEqual([0]);
    });

    test("frame exceeding 1 MiB fails closed with protocol error", async () => {
      const exits: number[] = [];
      const encoder = new TextEncoder();
      // Produce a JSON chunk whose text field pushes the line over 1 MiB
      const bigText = "x".repeat(1024 * 1024 + 1);
      const oversizedLine = `${JSON.stringify({ kind: "chunk", text: bigText })}\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(oversizedLine));
          controller.close();
        },
      });
      const fetch = mock(async () =>
        Promise.resolve(new Response(stream, { status: 200 })),
      ) as unknown as typeof globalThis.fetch;
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
      expect(exits).toEqual([1]);
      const text = output
        .read(0)
        .map((c) => c.content)
        .join("");
      expect(text).toContain("frame exceeds maximum size");
    });
  });
});
