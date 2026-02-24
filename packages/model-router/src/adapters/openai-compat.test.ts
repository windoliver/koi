import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ModelRequest } from "@koi/core";
import type { StreamChunk } from "../provider-adapter.js";
import { createOpenAICompatibleAdapter } from "./openai-compat.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(response: {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}): ReturnType<typeof mock> {
  const fn = mock(() =>
    Promise.resolve({
      ok: response.ok,
      status: response.status,
      headers: new Headers(response.headers ?? {}),
      json: () => Promise.resolve(response.body),
      text: () => Promise.resolve(JSON.stringify(response.body)),
    }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function makeRequest(text = "hello"): ModelRequest {
  return {
    messages: [{ content: [{ kind: "text" as const, text }], senderId: "user", timestamp: 0 }],
  };
}

describe("createOpenAICompatibleAdapter", () => {
  test("complete sends request to base URL + /chat/completions", async () => {
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      body: {
        id: "gen-1",
        model: "test-model",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    });

    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "http://localhost:11434/v1",
      providerName: "Test",
    });

    const result = await adapter.complete(makeRequest());

    expect(result.content).toBe("hi");
    expect(result.model).toBe("test-model");
    expect(result.usage?.inputTokens).toBe(5);

    const calledUrl = (fetchFn.mock.calls[0] as [string, unknown])[0];
    expect(calledUrl).toBe("http://localhost:11434/v1/chat/completions");
  });

  test("complete works without apiKey (no auth header)", async () => {
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      body: {
        id: "gen-1",
        model: "llama3",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      },
    });

    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "http://localhost:11434/v1",
      providerName: "Ollama",
    });

    await adapter.complete(makeRequest());

    const calledInit = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    const headers = calledInit.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  test("complete includes Bearer token when apiKey provided", async () => {
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      body: {
        id: "gen-1",
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      },
    });

    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-key",
      providerName: "OpenAI",
    });

    await adapter.complete(makeRequest());

    const calledInit = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    const headers = calledInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-key");
  });

  test("complete uses defaultModel when request has no model", async () => {
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      body: {
        id: "gen-1",
        model: "llama3.2",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      },
    });

    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "http://localhost:11434/v1",
      providerName: "Test",
      defaultModel: "llama3.2",
    });

    await adapter.complete(makeRequest());

    const calledBody = JSON.parse(
      (fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { model: string };
    expect(calledBody.model).toBe("llama3.2");
  });

  test("complete throws KoiError on non-ok response", async () => {
    mockFetch({
      ok: false,
      status: 429,
      body: { error: { message: "Rate limited" } },
      headers: { "retry-after": "2" },
    });

    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "http://localhost:11434/v1",
      providerName: "TestProvider",
    });

    try {
      await adapter.complete(makeRequest());
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      const koiError = error as {
        code: string;
        message: string;
        retryable: boolean;
        retryAfterMs?: number;
      };
      expect(koiError.code).toBe("RATE_LIMIT");
      expect(koiError.message).toContain("TestProvider API error 429");
      expect(koiError.retryable).toBe(true);
      expect(koiError.retryAfterMs).toBe(2000);
    }
  });

  test("complete throws TIMEOUT error on abort", async () => {
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "http://localhost:11434/v1",
      providerName: "Test",
      timeoutMs: 100,
    });

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

  test("complete includes custom headers", async () => {
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      body: {
        id: "gen-1",
        model: "test",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      },
    });

    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "http://localhost:11434/v1",
      providerName: "Test",
      headers: { "X-Custom": "my-value" },
    });

    await adapter.complete(makeRequest());

    const calledInit = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["X-Custom"]).toBe("my-value");
  });
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
            'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
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

    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "http://localhost:11434/v1",
      providerName: "Test",
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.kind === "text_delta")).toBe(true);
    expect(chunks.some((c) => c.kind === "finish")).toBe(true);
    const textChunk = chunks.find((c) => c.kind === "text_delta");
    if (textChunk?.kind === "text_delta") {
      expect(textChunk.text).toBe("Hello");
    }
  });

  test("yields error chunk on non-ok response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: () => Promise.resolve("Internal Server Error"),
      }),
    ) as unknown as typeof fetch;

    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "http://localhost:11434/v1",
      providerName: "TestProvider",
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("error");
    if (chunks[0]?.kind === "error") {
      expect(chunks[0].message).toContain("TestProvider API error 500");
    }
  });

  test("yields error chunk when response body is null", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: null,
      }),
    ) as unknown as typeof fetch;

    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "http://localhost:11434/v1",
      providerName: "Test",
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("error");
    if (chunks[0]?.kind === "error") {
      expect(chunks[0].message).toContain("No response body");
    }
  });

  test("yields finish_reason from stream chunks", async () => {
    const encoder = new TextEncoder();
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n'),
        );
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'),
        );
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

    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "http://localhost:11434/v1",
      providerName: "Test",
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk);
    }

    const finishChunk = chunks.find((c) => c.kind === "finish");
    expect(finishChunk).toBeDefined();
    if (finishChunk?.kind === "finish") {
      expect(finishChunk.reason).toBe("stop");
    }
  });

  test("yields error on idle timeout during stream", async () => {
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const mockStream = new ReadableStream({
        pull() {
          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          });
        },
      });

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream,
      });
    }) as unknown as typeof fetch;

    const adapter = createOpenAICompatibleAdapter({
      baseUrl: "http://localhost:11434/v1",
      providerName: "Test",
      timeoutMs: 100,
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.kind === "error")).toBe(true);
    const errorChunk = chunks.find((c) => c.kind === "error");
    if (errorChunk?.kind === "error") {
      expect(errorChunk.message).toContain("timeout");
    }
  }, 10_000);
});
