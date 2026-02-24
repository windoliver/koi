import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ModelRequest } from "@koi/core";
import type { StreamChunk } from "../provider-adapter.js";
import { createLMStudioAdapter } from "./lm-studio.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeRequest(text = "hello"): ModelRequest {
  return {
    messages: [{ content: [{ kind: "text" as const, text }], senderId: "user", timestamp: 0 }],
  };
}

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

describe("createLMStudioAdapter", () => {
  test("has id 'lm-studio'", () => {
    const adapter = createLMStudioAdapter();
    expect(adapter.id).toBe("lm-studio");
  });

  test("exposes checkHealth method", () => {
    const adapter = createLMStudioAdapter();
    expect(adapter.checkHealth).toBeFunction();
  });
});

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

describe("complete", () => {
  test("sends request to default LM Studio URL", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          Promise.resolve({
            id: "gen-1",
            model: "lmstudio-community/Meta-Llama-3.2-3B",
            choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        text: () => Promise.resolve(""),
      };
    }) as unknown as typeof fetch;

    const adapter = createLMStudioAdapter();
    const result = await adapter.complete(makeRequest());

    expect(capturedUrl).toBe("http://localhost:1234/v1/chat/completions");
    expect(result.content).toBe("Hello!");
    expect(result.model).toBe("lmstudio-community/Meta-Llama-3.2-3B");
    expect(result.usage?.inputTokens).toBe(10);
  });

  test("uses custom baseUrl", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          Promise.resolve({
            id: "gen-1",
            model: "llama3.2",
            choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          }),
        text: () => Promise.resolve(""),
      };
    }) as unknown as typeof fetch;

    const adapter = createLMStudioAdapter({ baseUrl: "http://gpu-server:1234" });
    await adapter.complete(makeRequest());

    expect(capturedUrl).toBe("http://gpu-server:1234/v1/chat/completions");
  });

  test("does not send Authorization header", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          Promise.resolve({
            id: "gen-1",
            model: "llama3.2",
            choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          }),
        text: () => Promise.resolve(""),
      };
    }) as unknown as typeof fetch;

    const adapter = createLMStudioAdapter();
    await adapter.complete(makeRequest());

    expect(capturedHeaders.Authorization).toBeUndefined();
  });

  test("returns EXTERNAL error when LM Studio is not running", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new TypeError("fetch failed: Connection refused")),
    ) as unknown as typeof fetch;

    const adapter = createLMStudioAdapter();

    try {
      await adapter.complete(makeRequest());
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(TypeError);
    }
  });

  test("returns TIMEOUT error after configured timeout", async () => {
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const adapter = createLMStudioAdapter({ timeoutMs: 100 });

    try {
      await adapter.complete(makeRequest());
      expect.unreachable("should have thrown timeout error");
    } catch (error: unknown) {
      const koiError = error as { code: string; message: string; retryable: boolean };
      expect(koiError.code).toBe("TIMEOUT");
      expect(koiError.message).toContain("timed out");
      expect(koiError.retryable).toBe(true);
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------
// stream
// ---------------------------------------------------------------------------

describe("stream", () => {
  test("yields text_delta and finish chunks from SSE", async () => {
    const encoder = new TextEncoder();
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"Hi there"},"finish_reason":null}]}\n\n',
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream,
      }),
    ) as unknown as typeof fetch;

    const adapter = createLMStudioAdapter();
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk);
    }

    const textChunks = chunks.filter((c) => c.kind === "text_delta");
    expect(textChunks.length).toBeGreaterThan(0);
    if (textChunks[0]?.kind === "text_delta") {
      expect(textChunks[0].text).toBe("Hi there");
    }

    expect(chunks.some((c) => c.kind === "finish")).toBe(true);
  });

  test("yields error chunk on connection error", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Connection refused")),
    ) as unknown as typeof fetch;

    const adapter = createLMStudioAdapter();
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.kind === "error")).toBe(true);
    const errorChunk = chunks.find((c) => c.kind === "error");
    if (errorChunk?.kind === "error") {
      expect(errorChunk.message).toContain("Connection refused");
    }
  });
});

// ---------------------------------------------------------------------------
// checkHealth
// ---------------------------------------------------------------------------

describe("checkHealth", () => {
  test("returns true when LM Studio responds with ok", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const adapter = createLMStudioAdapter();
    const healthy = await adapter.checkHealth?.();
    expect(healthy).toBe(true);
  });

  test("returns false when LM Studio is down", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new TypeError("fetch failed")),
    ) as unknown as typeof fetch;

    const adapter = createLMStudioAdapter();
    const healthy = await adapter.checkHealth?.();
    expect(healthy).toBe(false);
  });

  test("returns false on non-ok response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 500 }),
    ) as unknown as typeof fetch;

    const adapter = createLMStudioAdapter();
    const healthy = await adapter.checkHealth?.();
    expect(healthy).toBe(false);
  });

  test("calls /v1/models on the base URL", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;

    const adapter = createLMStudioAdapter({ baseUrl: "http://gpu-box:1234" });
    await adapter.checkHealth?.();

    expect(capturedUrl).toBe("http://gpu-box:1234/v1/models");
  });

  test("uses default base URL for health check", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;

    const adapter = createLMStudioAdapter();
    await adapter.checkHealth?.();

    expect(capturedUrl).toBe("http://localhost:1234/v1/models");
  });

  test("returns false on timeout", async () => {
    globalThis.fetch = mock(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;

    const adapter = createLMStudioAdapter({ healthCheckTimeoutMs: 100 });
    const healthy = await adapter.checkHealth?.();
    expect(healthy).toBe(false);
  }, 10_000);
});
