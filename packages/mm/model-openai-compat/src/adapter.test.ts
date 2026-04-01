/**
 * Adapter integration tests — uses Bun.serve() mock server with recorded fixtures.
 * Tests the full request → streaming → response path.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ModelChunk, ModelRequest } from "@koi/core";
import { createOpenAICompatAdapter } from "./adapter.js";

// ---------------------------------------------------------------------------
// Mock SSE server
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

// Route map: path → { status, headers?, body }
const routes = new Map<
  string,
  { status: number; headers?: Record<string, string>; body: string }
>();

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const route = routes.get(url.pathname);
      if (route === undefined) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(route.body, {
        status: route.status,
        headers: {
          "Content-Type": route.status >= 400 ? "application/json" : "text/event-stream",
          ...route.headers,
        },
      });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

function makeRequest(text: string): ModelRequest {
  return {
    messages: [
      {
        content: [{ kind: "text", text }],
        senderId: "test",
        timestamp: Date.now(),
      },
    ],
  };
}

async function collectChunks(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Successful text stream
// ---------------------------------------------------------------------------

describe("adapter: text stream", () => {
  test("streams text deltas and produces done", async () => {
    routes.set("/v1/chat/completions", {
      status: 200,
      body: [
        `data: {"id":"g1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`,
        ``,
        `data: {"id":"g1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}`,
        ``,
        `data: {"id":"g1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}`,
        ``,
        `data: [DONE]`,
        ``,
      ].join("\n"),
    });

    const adapter = createOpenAICompatAdapter({
      apiKey: "test-key",
      baseUrl: `${baseUrl}/v1`,
      model: "test-model",
    });

    const chunks = await collectChunks(adapter.stream(makeRequest("hi")));

    const textDeltas = chunks.filter((c) => c.kind === "text_delta");
    expect(textDeltas).toHaveLength(2);
    if (textDeltas[0]?.kind === "text_delta") expect(textDeltas[0].delta).toBe("Hello");
    if (textDeltas[1]?.kind === "text_delta") expect(textDeltas[1].delta).toBe(" world");

    const done = chunks.find((c) => c.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.response.content).toBe("Hello world");
      expect(done.response.stopReason).toBe("stop");
    }
  });
});

// ---------------------------------------------------------------------------
// Tool call stream
// ---------------------------------------------------------------------------

describe("adapter: tool call stream", () => {
  test("streams tool call start, delta, end", async () => {
    routes.set("/v1/chat/completions", {
      status: 200,
      body: [
        `data: {"id":"g2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":""}}]},"finish_reason":null}]}`,
        ``,
        `data: {"id":"g2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\"test\\"}"}}]},"finish_reason":null}]}`,
        ``,
        `data: {"id":"g2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":15,"completion_tokens":8}}`,
        ``,
        `data: [DONE]`,
        ``,
      ].join("\n"),
    });

    const adapter = createOpenAICompatAdapter({
      apiKey: "test-key",
      baseUrl: `${baseUrl}/v1`,
      model: "test-model",
    });

    const chunks = await collectChunks(adapter.stream(makeRequest("search for test")));

    const starts = chunks.filter((c) => c.kind === "tool_call_start");
    expect(starts).toHaveLength(1);
    if (starts[0]?.kind === "tool_call_start") {
      expect(starts[0].toolName).toBe("search");
    }

    const deltas = chunks.filter((c) => c.kind === "tool_call_delta");
    expect(deltas.length).toBeGreaterThan(0);

    const done = chunks.find((c) => c.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.response.stopReason).toBe("tool_use");
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP 429 rate limit
// ---------------------------------------------------------------------------

describe("adapter: HTTP 429 rate limit", () => {
  test("produces RATE_LIMIT error with retryAfterMs hint", async () => {
    routes.set("/v1/chat/completions", {
      status: 429,
      headers: { "retry-after": "30" },
      body: JSON.stringify({
        error: { message: "Rate limit exceeded" },
      }),
    });

    const adapter = createOpenAICompatAdapter({
      apiKey: "test-key",
      baseUrl: `${baseUrl}/v1`,
      model: "test-model",
    });

    const chunks = await collectChunks(adapter.stream(makeRequest("hi")));

    const errorChunk = chunks.find((c) => c.kind === "error");
    expect(errorChunk).toBeDefined();
    if (errorChunk?.kind === "error") {
      expect(errorChunk.code).toBe("RATE_LIMIT");
      expect(errorChunk.message).toContain("Rate limit exceeded");
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP 401 auth error
// ---------------------------------------------------------------------------

describe("adapter: HTTP 401 auth error", () => {
  test("produces PERMISSION error", async () => {
    routes.set("/v1/chat/completions", {
      status: 401,
      body: JSON.stringify({
        error: { message: "Invalid API key provided." },
      }),
    });

    const adapter = createOpenAICompatAdapter({
      apiKey: "bad-key",
      baseUrl: `${baseUrl}/v1`,
      model: "test-model",
    });

    const chunks = await collectChunks(adapter.stream(makeRequest("hi")));

    const errorChunk = chunks.find((c) => c.kind === "error");
    expect(errorChunk).toBeDefined();
    if (errorChunk?.kind === "error") {
      expect(errorChunk.code).toBe("PERMISSION");
    }
  });
});

// ---------------------------------------------------------------------------
// complete() (non-streaming wrapper)
// ---------------------------------------------------------------------------

describe("adapter: complete()", () => {
  test("returns accumulated ModelResponse", async () => {
    routes.set("/v1/chat/completions", {
      status: 200,
      body: [
        `data: {"id":"gc","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":null}]}`,
        ``,
        `data: {"id":"gc","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}`,
        ``,
        `data: [DONE]`,
        ``,
      ].join("\n"),
    });

    const adapter = createOpenAICompatAdapter({
      apiKey: "test-key",
      baseUrl: `${baseUrl}/v1`,
      model: "test-model",
    });

    const response = await adapter.complete(makeRequest("hi"));
    expect(response.content).toBe("Done");
    expect(response.stopReason).toBe("stop");
  });

  test("P1 fix: complete() throws on abort instead of returning empty", async () => {
    routes.set("/v1/chat/completions", {
      status: 200,
      body: [
        `data: {"id":"gx","choices":[{"index":0,"delta":{"content":"data"},"finish_reason":null}]}`,
        ``,
        `data: {"id":"gx","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
        ``,
        `data: [DONE]`,
        ``,
      ].join("\n"),
    });

    const controller = new AbortController();
    const adapter = createOpenAICompatAdapter({
      apiKey: "test-key",
      baseUrl: `${baseUrl}/v1`,
      model: "test-model",
    });

    controller.abort(); // Pre-abort
    const request: ModelRequest = {
      ...makeRequest("hi"),
      signal: controller.signal,
    };

    await expect(adapter.complete(request)).rejects.toThrow("Request was aborted");
  });

  test("throws on HTTP error", async () => {
    routes.set("/v1/chat/completions", {
      status: 500,
      body: JSON.stringify({ error: { message: "Server error" } }),
    });

    const adapter = createOpenAICompatAdapter({
      apiKey: "test-key",
      baseUrl: `${baseUrl}/v1`,
      model: "test-model",
    });

    await expect(adapter.complete(makeRequest("hi"))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Edge case 5: Mid-stream abort
// ---------------------------------------------------------------------------

describe("adapter: mid-stream abort", () => {
  test("terminates cleanly on abort", async () => {
    routes.set("/v1/chat/completions", {
      status: 200,
      body: [
        `data: {"id":"ga","choices":[{"index":0,"delta":{"content":"Start"},"finish_reason":null}]}`,
        ``,
        // Simulate a long stream — the abort should cut it short
        `data: {"id":"ga","choices":[{"index":0,"delta":{"content":" more data"},"finish_reason":null}]}`,
        ``,
        `data: {"id":"ga","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}`,
        ``,
        `data: [DONE]`,
        ``,
      ].join("\n"),
    });

    const controller = new AbortController();
    const adapter = createOpenAICompatAdapter({
      apiKey: "test-key",
      baseUrl: `${baseUrl}/v1`,
      model: "test-model",
    });

    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text", text: "hi" }],
          senderId: "test",
          timestamp: Date.now(),
        },
      ],
      signal: controller.signal,
    };

    // Abort after collecting first chunk
    const chunks: ModelChunk[] = [];
    for await (const chunk of adapter.stream(request)) {
      chunks.push(chunk);
      if (chunks.length === 1) {
        controller.abort();
      }
    }

    // Should have at least 1 chunk but no error chunk (clean abort)
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const errorChunks = chunks.filter((c) => c.kind === "error");
    expect(errorChunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Adversarial fix: truncated stream emits error, not done
// ---------------------------------------------------------------------------

describe("adapter: truncated stream detection", () => {
  test("emits error when stream ends without [DONE] or finish_reason", async () => {
    // Simulate a stream that just sends content then closes — no finish_reason, no [DONE]
    routes.set("/v1/chat/completions", {
      status: 200,
      body: [
        `data: {"id":"gt","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}`,
        ``,
        // Stream ends here — no finish_reason, no [DONE]
      ].join("\n"),
    });

    const adapter = createOpenAICompatAdapter({
      apiKey: "test-key",
      baseUrl: `${baseUrl}/v1`,
      model: "test-model",
    });

    const chunks = await collectChunks(adapter.stream(makeRequest("hi")));

    // Should NOT have a done chunk
    const doneChunks = chunks.filter((c) => c.kind === "done");
    expect(doneChunks).toHaveLength(0);

    // Should have an error chunk about truncation
    const errorChunk = chunks.find((c) => c.kind === "error");
    expect(errorChunk).toBeDefined();
    if (errorChunk?.kind === "error") {
      expect(errorChunk.message).toContain("truncation");
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial fix: retryAfterMs propagated in error chunk
// ---------------------------------------------------------------------------

describe("adapter: retry metadata propagation", () => {
  test("429 error chunk includes retryable and retryAfterMs", async () => {
    routes.set("/v1/chat/completions", {
      status: 429,
      headers: { "retry-after": "15" },
      body: JSON.stringify({ error: { message: "Rate limited" } }),
    });

    const adapter = createOpenAICompatAdapter({
      apiKey: "test-key",
      baseUrl: `${baseUrl}/v1`,
      model: "test-model",
    });

    const chunks = await collectChunks(adapter.stream(makeRequest("hi")));
    const errorChunk = chunks.find((c) => c.kind === "error");
    expect(errorChunk).toBeDefined();
    if (errorChunk?.kind === "error") {
      expect(errorChunk.code).toBe("RATE_LIMIT");
      expect(errorChunk.retryable).toBe(true);
      expect(errorChunk.retryAfterMs).toBe(15_000);
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial fix: response model reflects per-request override
// ---------------------------------------------------------------------------

describe("adapter: model override in response", () => {
  test("done.response.model reflects request.model override", async () => {
    routes.set("/v1/chat/completions", {
      status: 200,
      body: [
        `data: {"id":"gm","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}`,
        ``,
        `data: {"id":"gm","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
        ``,
        `data: [DONE]`,
        ``,
      ].join("\n"),
    });

    const adapter = createOpenAICompatAdapter({
      apiKey: "test-key",
      baseUrl: `${baseUrl}/v1`,
      model: "default-model",
    });

    const request: ModelRequest = {
      ...makeRequest("hi"),
      model: "override-model",
    };

    const chunks = await collectChunks(adapter.stream(request));
    const done = chunks.find((c) => c.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.response.model).toBe("override-model");
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial fix: [DONE] without finish_reason is an error
// ---------------------------------------------------------------------------

describe("adapter: [DONE] without finish_reason", () => {
  test("emits error when [DONE] arrives but no finish_reason was seen", async () => {
    routes.set("/v1/chat/completions", {
      status: 200,
      body: [
        `data: {"id":"gd","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}`,
        ``,
        `data: [DONE]`,
        ``,
      ].join("\n"),
    });

    const adapter = createOpenAICompatAdapter({
      apiKey: "test-key",
      baseUrl: `${baseUrl}/v1`,
      model: "test-model",
    });

    const chunks = await collectChunks(adapter.stream(makeRequest("hi")));

    const doneChunks = chunks.filter((c) => c.kind === "done");
    expect(doneChunks).toHaveLength(0);

    const errorChunk = chunks.find((c) => c.kind === "error");
    expect(errorChunk).toBeDefined();
    if (errorChunk?.kind === "error") {
      expect(errorChunk.message).toContain("[DONE]");
      expect(errorChunk.message).toContain("finish_reason");
    }
  });
});

// ---------------------------------------------------------------------------
// Config validation: vision override rejected
// ---------------------------------------------------------------------------

describe("adapter: config validation", () => {
  test("rejects vision: true in capabilities override", () => {
    expect(() =>
      createOpenAICompatAdapter({
        apiKey: "test-key",
        baseUrl: `${baseUrl}/v1`,
        model: "test-model",
        capabilities: { vision: true },
      }),
    ).toThrow("vision");
  });
});
