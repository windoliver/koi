/**
 * Contract test suite for ModelAdapter.
 *
 * Reusable by future provider packages — import runModelAdapterContractTests()
 * and supply your adapter + mock server.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ModelAdapter, ModelChunk, ModelRequest } from "@koi/core";
import { createOpenAICompatAdapter } from "../src/adapter.js";

// ---------------------------------------------------------------------------
// Reusable contract test runner
// ---------------------------------------------------------------------------

export function runModelAdapterContractTests(
  name: string,
  setup: () => {
    adapter: ModelAdapter;
    mockRoutes: Map<string, { status: number; headers?: Record<string, string>; body: string }>;
  },
): void {
  describe(`ModelAdapter contract: ${name}`, () => {
    let ctx: ReturnType<typeof setup>;

    beforeEach(() => {
      ctx = setup();
    });

    function makeRequest(text: string): ModelRequest {
      return {
        messages: [
          {
            content: [{ kind: "text", text }],
            senderId: "contract-test",
            timestamp: Date.now(),
          },
        ],
      };
    }

    async function collectChunks(iterable: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
      const chunks: ModelChunk[] = [];
      for await (const chunk of iterable) {
        chunks.push(chunk);
      }
      return chunks;
    }

    test("1. complete() returns valid ModelResponse with required fields", async () => {
      ctx.mockRoutes.set("/v1/chat/completions", {
        status: 200,
        body: [
          `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}`,
          ``,
          `data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}`,
          ``,
          `data: [DONE]`,
          ``,
        ].join("\n"),
      });

      const response = await ctx.adapter.complete(makeRequest("test"));
      expect(typeof response.content).toBe("string");
      expect(typeof response.model).toBe("string");
    });

    test("2. stream() yields valid ModelChunk sequence ending with done", async () => {
      ctx.mockRoutes.set("/v1/chat/completions", {
        status: 200,
        body: [
          `data: {"id":"s1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}`,
          ``,
          `data: {"id":"s1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
          ``,
          `data: [DONE]`,
          ``,
        ].join("\n"),
      });

      const chunks = await collectChunks(ctx.adapter.stream(makeRequest("test")));
      expect(chunks.length).toBeGreaterThan(0);

      const done = chunks.find((c) => c.kind === "done");
      expect(done).toBeDefined();
    });

    test("3. stream() with tool calls yields start/delta/end in order", async () => {
      ctx.mockRoutes.set("/v1/chat/completions", {
        status: 200,
        body: [
          `data: {"id":"t1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fn","arguments":""}}]},"finish_reason":null}]}`,
          ``,
          `data: {"id":"t1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":null}]}`,
          ``,
          `data: {"id":"t1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}`,
          ``,
          `data: [DONE]`,
          ``,
        ].join("\n"),
      });

      const chunks = await collectChunks(ctx.adapter.stream(makeRequest("test")));

      const starts = chunks.filter((c) => c.kind === "tool_call_start");
      const ends = chunks.filter((c) => c.kind === "tool_call_end");
      expect(starts.length).toBeGreaterThanOrEqual(1);
      expect(ends.length).toBeGreaterThanOrEqual(1);

      // start must come before end
      const startIdx = chunks.findIndex((c) => c.kind === "tool_call_start");
      const endIdx = chunks.findIndex((c) => c.kind === "tool_call_end");
      expect(startIdx).toBeLessThan(endIdx);
    });

    test("4. abort signal terminates stream cleanly", async () => {
      ctx.mockRoutes.set("/v1/chat/completions", {
        status: 200,
        body: [
          `data: {"id":"a1","choices":[{"index":0,"delta":{"content":"data"},"finish_reason":null}]}`,
          ``,
          `data: {"id":"a1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
          ``,
          `data: [DONE]`,
          ``,
        ].join("\n"),
      });

      const controller = new AbortController();
      const request: ModelRequest = {
        messages: [
          { content: [{ kind: "text", text: "hi" }], senderId: "t", timestamp: Date.now() },
        ],
        signal: controller.signal,
      };

      const chunks: ModelChunk[] = [];
      controller.abort();
      // Stream after abort should not throw, just return early
      for await (const chunk of ctx.adapter.stream(request)) {
        chunks.push(chunk);
      }
      // No error chunks expected for clean abort
      const errors = chunks.filter((c) => c.kind === "error");
      expect(errors).toHaveLength(0);
    });

    test("5. HTTP 429 produces RATE_LIMIT error", async () => {
      ctx.mockRoutes.set("/v1/chat/completions", {
        status: 429,
        headers: { "retry-after": "5" },
        body: JSON.stringify({ error: { message: "Rate limited" } }),
      });

      const chunks = await collectChunks(ctx.adapter.stream(makeRequest("test")));
      const error = chunks.find((c) => c.kind === "error");
      expect(error).toBeDefined();
      if (error?.kind === "error") {
        expect(error.code).toBe("RATE_LIMIT");
      }
    });

    test("6. HTTP 401 produces PERMISSION error", async () => {
      ctx.mockRoutes.set("/v1/chat/completions", {
        status: 401,
        body: JSON.stringify({ error: { message: "Unauthorized" } }),
      });

      const chunks = await collectChunks(ctx.adapter.stream(makeRequest("test")));
      const error = chunks.find((c) => c.kind === "error");
      expect(error).toBeDefined();
      if (error?.kind === "error") {
        expect(error.code).toBe("PERMISSION");
      }
    });

    test("7. dispose is callable and idempotent", async () => {
      if (ctx.adapter.dispose !== undefined) {
        await ctx.adapter.dispose();
        await ctx.adapter.dispose(); // second call should not throw
      }
      // If dispose is undefined, this test passes trivially
      expect(true).toBe(true);
    });
  });
}

// ---------------------------------------------------------------------------
// Run contract tests for the OpenRouter adapter
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
const mockRoutes = new Map<
  string,
  { status: number; headers?: Record<string, string>; body: string }
>();

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const route = mockRoutes.get(url.pathname);
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
});

afterAll(() => {
  server.stop();
});

runModelAdapterContractTests("OpenRouter", () => ({
  adapter: createOpenAICompatAdapter({
    apiKey: "contract-test-key",
    baseUrl: `http://localhost:${server.port}/v1`,
    model: "test-model",
  }),
  mockRoutes,
}));
