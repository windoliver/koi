import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ModelRequest } from "@koi/core";
import type { StreamChunk } from "../provider-adapter.js";
import { createOpenRouterAdapter } from "./openrouter.js";

const originalFetch = globalThis.fetch;

// Tracks the last mock so tests can inspect calls without re-casting globalThis.fetch
let lastFetchMock: ReturnType<typeof mock>;

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
  lastFetchMock = fn;
  return fn;
}

function getCallArgs(callIndex = 0): [string, RequestInit] {
  return lastFetchMock.mock.calls[callIndex] as [string, RequestInit];
}

function getSentHeaders(callIndex = 0): Record<string, string> {
  return getCallArgs(callIndex)[1].headers as Record<string, string>;
}

describe("createOpenRouterAdapter", () => {
  test("has id 'openrouter'", () => {
    const adapter = createOpenRouterAdapter({ apiKey: "test-key" });
    expect(adapter.id).toBe("openrouter");
  });

  test("defaults model to openai/gpt-4o", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: {
        id: "gen-123",
        model: "openai/gpt-4o",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    });

    const adapter = createOpenRouterAdapter({ apiKey: "test-key" });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hello" }], senderId: "user", timestamp: 0 },
      ],
    };

    await adapter.complete(request);

    const calledBody = JSON.parse(getCallArgs()[1].body as string) as { model: string };
    expect(calledBody.model).toBe("openai/gpt-4o");
  });

  test("sends Authorization Bearer header", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: {
        id: "gen-123",
        model: "openai/gpt-4o",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      },
    });

    const adapter = createOpenRouterAdapter({ apiKey: "sk-or-test-123" });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hello" }], senderId: "user", timestamp: 0 },
      ],
    };

    await adapter.complete(request);

    expect(getSentHeaders().Authorization).toBe("Bearer sk-or-test-123");
  });

  test("includes HTTP-Referer when referer is set", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: {
        id: "gen-123",
        model: "openai/gpt-4o",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      },
    });

    const adapter = createOpenRouterAdapter({
      apiKey: "test-key",
      referer: "https://myapp.dev",
    });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hello" }], senderId: "user", timestamp: 0 },
      ],
    };

    await adapter.complete(request);

    expect(getSentHeaders()["HTTP-Referer"]).toBe("https://myapp.dev");
  });

  test("includes X-Title when appName is set", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: {
        id: "gen-123",
        model: "openai/gpt-4o",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      },
    });

    const adapter = createOpenRouterAdapter({
      apiKey: "test-key",
      appName: "Koi Agent Engine",
    });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hello" }], senderId: "user", timestamp: 0 },
      ],
    };

    await adapter.complete(request);

    expect(getSentHeaders()["X-Title"]).toBe("Koi Agent Engine");
  });

  test("custom headers override defaults", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: {
        id: "gen-123",
        model: "openai/gpt-4o",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      },
    });

    const adapter = createOpenRouterAdapter({
      apiKey: "test-key",
      headers: { "X-Custom": "custom-value" },
    });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hello" }], senderId: "user", timestamp: 0 },
      ],
    };

    await adapter.complete(request);

    expect(getSentHeaders()["X-Custom"]).toBe("custom-value");
  });

  test("uses default base URL targeting OpenRouter", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: {
        id: "gen-123",
        model: "openai/gpt-4o",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      },
    });

    const adapter = createOpenRouterAdapter({ apiKey: "test-key" });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hello" }], senderId: "user", timestamp: 0 },
      ],
    };

    await adapter.complete(request);

    const calledUrl = getCallArgs()[0];
    expect(calledUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  test("throws KoiError on non-ok response", async () => {
    mockFetch({
      ok: false,
      status: 401,
      body: { error: { message: "Invalid API key" } },
    });

    const adapter = createOpenRouterAdapter({ apiKey: "bad-key" });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hello" }], senderId: "user", timestamp: 0 },
      ],
    };

    try {
      await adapter.complete(request);
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      const koiError = error as { code: string; message: string; retryable: boolean };
      expect(koiError.code).toBe("PERMISSION");
      expect(koiError.message).toContain("OpenRouter API error 401");
      expect(koiError.retryable).toBe(false);
    }
  });

  test("parses response with usage info", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: {
        id: "gen-456",
        model: "anthropic/claude-haiku-3-5-20241022",
        choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      },
    });

    const adapter = createOpenRouterAdapter({ apiKey: "test-key" });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hi" }], senderId: "user", timestamp: 0 },
      ],
      model: "anthropic/claude-haiku-3-5-20241022",
    };

    const result = await adapter.complete(request);

    expect(result.content).toBe("Hello!");
    expect(result.model).toBe("anthropic/claude-haiku-3-5-20241022");
    expect(result.usage?.inputTokens).toBe(12);
    expect(result.usage?.outputTokens).toBe(3);
  });

  test("includes retryAfterMs when Retry-After header present", async () => {
    mockFetch({
      ok: false,
      status: 429,
      body: { error: { message: "Rate limited" } },
      headers: { "retry-after": "5.5" },
    });

    const adapter = createOpenRouterAdapter({ apiKey: "test-key" });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hello" }], senderId: "user", timestamp: 0 },
      ],
    };

    try {
      await adapter.complete(request);
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      const koiError = error as { code: string; retryAfterMs?: number; retryable: boolean };
      expect(koiError.code).toBe("RATE_LIMIT");
      expect(koiError.retryAfterMs).toBe(5500);
      expect(koiError.retryable).toBe(true);
    }
  });

  test("throws KoiError on timeout in complete()", async () => {
    // Mock that respects AbortSignal — needed because real fetch honours signal but mocks don't
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const adapter = createOpenRouterAdapter({ apiKey: "test-key", timeoutMs: 100 });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hello" }], senderId: "user", timestamp: 0 },
      ],
    };

    try {
      await adapter.complete(request);
      expect.unreachable("should have thrown timeout error");
    } catch (error: unknown) {
      const koiError = error as { code: string; message: string; retryable: boolean };
      expect(koiError.code).toBe("TIMEOUT");
      expect(koiError.message).toContain("timed out");
      expect(koiError.retryable).toBe(true);
    }
  }, 10_000);
});

describe("stream method (non-streaming fetch+parse)", () => {
  test("yields text_delta and finish chunks from JSON response", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: {
        model: "anthropic/claude-sonnet-4",
        choices: [{ message: { content: "Hello" }, finish_reason: "stop" }],
      },
    });

    const adapter = createOpenRouterAdapter({ apiKey: "test-key" });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hi" }], senderId: "user", timestamp: 0 },
      ],
    };

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(request)) {
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
    mockFetch({ ok: false, status: 429, body: "Rate limited" });

    const adapter = createOpenRouterAdapter({ apiKey: "test-key" });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hi" }], senderId: "user", timestamp: 0 },
      ],
    };

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(request)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("error");
    if (chunks[0]?.kind === "error") {
      expect(chunks[0].message).toContain("OpenRouter API error 429");
    }
  });

  test("yields error chunk when choices array is empty", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { model: "test", choices: [] },
    });

    const adapter = createOpenRouterAdapter({ apiKey: "test-key" });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hi" }], senderId: "user", timestamp: 0 },
      ],
    };

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(request)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("error");
    if (chunks[0]?.kind === "error") {
      expect(chunks[0].message).toContain("empty choices");
    }
  });

  test("yields finish_reason from JSON response", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: {
        model: "test",
        choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
      },
    });

    const adapter = createOpenRouterAdapter({ apiKey: "test-key" });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hi" }], senderId: "user", timestamp: 0 },
      ],
    };

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(request)) {
      chunks.push(chunk);
    }

    const finishChunk = chunks.find((c) => c.kind === "finish");
    expect(finishChunk).toBeDefined();
    if (finishChunk?.kind === "finish") {
      expect(finishChunk.reason).toBe("stop");
    }
  });

  test("yields tool_call chunks from JSON response", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: {
        model: "test",
        choices: [
          {
            message: {
              tool_calls: [
                { id: "call_1", function: { name: "exec", arguments: '{"code":"2+2"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    });

    const adapter = createOpenRouterAdapter({ apiKey: "test-key" });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hi" }], senderId: "user", timestamp: 0 },
      ],
    };

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(request)) {
      chunks.push(chunk);
    }

    const toolChunk = chunks.find((c) => c.kind === "tool_call");
    expect(toolChunk).toBeDefined();
    if (toolChunk?.kind === "tool_call") {
      expect(toolChunk.toolName).toBe("exec");
      expect(toolChunk.callId).toBe("call_1");
    }
  });

  test("passes abort signal to fetch", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { model: "test", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
    });

    const ac = new AbortController();
    const adapter = createOpenRouterAdapter({ apiKey: "test-key" });
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "hi" }], senderId: "user", timestamp: 0 },
      ],
      signal: ac.signal,
    };

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(request)) {
      chunks.push(chunk);
    }

    // Verify signal was passed to fetch
    const [, init] = getCallArgs();
    expect(init.signal).toBe(ac.signal);
  });
});
