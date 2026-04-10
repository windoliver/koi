import { describe, expect, test } from "bun:test";
import type { ModelChunk, ModelRequest, ModelResponse } from "@koi/core";
import { validateRouterConfig } from "./config.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import { createModelRouter } from "./router.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeResponse(model: string): ModelResponse {
  return {
    content: `response from ${model}`,
    model,
    usage: { inputTokens: 10, outputTokens: 20 },
  };
}

function makeRequest(text = "hello"): ModelRequest {
  return {
    messages: [{ senderId: "user", content: [{ kind: "text", text }], timestamp: 0 }],
    model: "placeholder",
  };
}

function makeAdapter(
  id: string,
  opts: {
    completeWith?: ModelResponse | (() => Promise<ModelResponse>) | (() => ModelResponse);
    streamWith?: ModelChunk[];
    streamError?: Error;
    streamErrorAfterChunks?: { chunks: ModelChunk[]; error: Error };
    checkHealth?: () => Promise<boolean>;
  } = {},
): ProviderAdapter {
  return {
    id,
    async complete() {
      if (opts.completeWith === undefined) return makeResponse(id);
      if (typeof opts.completeWith === "function") return opts.completeWith();
      return opts.completeWith;
    },
    async *stream(): AsyncGenerator<ModelChunk> {
      if (opts.streamError !== undefined) {
        throw opts.streamError; // synchronous throw before first chunk
      }
      if (opts.streamErrorAfterChunks !== undefined) {
        for (const chunk of opts.streamErrorAfterChunks.chunks) {
          yield chunk;
        }
        throw opts.streamErrorAfterChunks.error;
      }
      const chunks = opts.streamWith ?? [{ kind: "text_delta", delta: `from ${id}` }];
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    ...(opts.checkHealth !== undefined ? { checkHealth: opts.checkHealth } : {}),
  };
}

function makeRouter(
  targets: Array<{ provider: string; model: string; enabled?: boolean; capabilities?: object }>,
  adapters: ReadonlyMap<string, ProviderAdapter>,
  opts: { circuitBreakerThreshold?: number } = {},
) {
  const configResult = validateRouterConfig({
    strategy: "fallback",
    targets: targets.map((t) => ({
      provider: t.provider,
      model: t.model,
      adapterConfig: {},
      enabled: t.enabled,
      capabilities: t.capabilities,
    })),
    retry: { maxRetries: 0 }, // no retries in unit tests
    circuitBreaker: {
      failureThreshold: opts.circuitBreakerThreshold ?? 3,
      cooldownMs: 60_000,
      failureWindowMs: 60_000,
      failureStatusCodes: [429, 500, 502, 503, 504],
    },
  });
  if (!configResult.ok) throw new Error(configResult.error.message);
  return createModelRouter(configResult.value, adapters, { clock: Date.now });
}

// ---------------------------------------------------------------------------
// Route (non-streaming)
// ---------------------------------------------------------------------------

describe("createModelRouter — route()", () => {
  test("routes to primary target on success", async () => {
    const adapters = new Map([
      ["openai", makeAdapter("openai", { completeWith: makeResponse("gpt-4o") })],
    ]);
    const router = makeRouter([{ provider: "openai", model: "gpt-4o" }], adapters);

    const result = await router.route(makeRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.model).toBe("gpt-4o");
    router.dispose();
  });

  test("failover: primary fails → secondary succeeds", async () => {
    let primaryCalls = 0;
    const adapters = new Map([
      [
        "primary",
        makeAdapter("primary", {
          completeWith: () => {
            primaryCalls++;
            throw new Error("down");
          },
        }),
      ],
      ["secondary", makeAdapter("secondary", { completeWith: makeResponse("secondary-model") })],
    ]);
    const router = makeRouter(
      [
        { provider: "primary", model: "m1" },
        { provider: "secondary", model: "m2" },
      ],
      adapters,
    );

    const result = await router.route(makeRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.model).toBe("secondary-model");
    expect(primaryCalls).toBe(1);
    router.dispose();
  });

  test("all targets fail → returns error result", async () => {
    const adapters = new Map([
      [
        "a",
        makeAdapter("a", {
          completeWith: () => {
            throw new Error("a-down");
          },
        }),
      ],
      [
        "b",
        makeAdapter("b", {
          completeWith: () => {
            throw new Error("b-down");
          },
        }),
      ],
    ]);
    const router = makeRouter(
      [
        { provider: "a", model: "m1" },
        { provider: "b", model: "m2" },
      ],
      adapters,
    );

    const result = await router.route(makeRequest());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error.message).toContain("a-down");
    expect(result.error.message).toContain("b-down");
    router.dispose();
  });

  test("skips disabled target", async () => {
    const tried: string[] = [];
    const adapters = new Map([
      [
        "a",
        makeAdapter("a", {
          completeWith: () => {
            tried.push("a");
            return makeResponse("a");
          },
        }),
      ],
      [
        "b",
        makeAdapter("b", {
          completeWith: () => {
            tried.push("b");
            return makeResponse("b");
          },
        }),
      ],
    ]);
    const router = makeRouter(
      [
        { provider: "a", model: "m1", enabled: false },
        { provider: "b", model: "m2" },
      ],
      adapters,
    );

    await router.route(makeRequest());
    expect(tried).toEqual(["b"]);
    router.dispose();
  });

  test("skips incompatible target (vision required, target lacks vision)", async () => {
    const tried: string[] = [];
    const adapters = new Map([
      [
        "noVision",
        makeAdapter("noVision", {
          completeWith: () => {
            tried.push("noVision");
            return makeResponse("noVision");
          },
        }),
      ],
      [
        "vision",
        makeAdapter("vision", {
          completeWith: () => {
            tried.push("vision");
            return makeResponse("vision");
          },
        }),
      ],
    ]);

    const imageRequest: ModelRequest = {
      messages: [
        {
          senderId: "user",
          content: [{ kind: "image", url: "https://example.com/img.png" }],
          timestamp: 0,
        },
      ],
      model: "placeholder",
    };

    const router = makeRouter(
      [
        { provider: "noVision", model: "m1", capabilities: { vision: false } },
        { provider: "vision", model: "m2", capabilities: { vision: true } },
      ],
      adapters,
    );

    await router.route(imageRequest);
    expect(tried).not.toContain("noVision");
    expect(tried).toContain("vision");
    router.dispose();
  });

  test("circuit breaker opens after threshold failures → subsequent calls skip target", async () => {
    let calls = 0;
    const adapters = new Map([
      [
        "a",
        makeAdapter("a", {
          completeWith: () => {
            calls++;
            throw new Error("down");
          },
        }),
      ],
      ["b", makeAdapter("b", { completeWith: makeResponse("b-model") })],
    ]);
    const router = makeRouter(
      [
        { provider: "a", model: "m1" },
        { provider: "b", model: "m2" },
      ],
      adapters,
      { circuitBreakerThreshold: 2 },
    );

    // First 2 calls both fail and try "a" (opening CB at threshold=2)
    await router.route(makeRequest());
    await router.route(makeRequest());
    const callsAtOpen = calls;

    // Third call: "a" circuit is open → should go directly to "b"
    const result = await router.route(makeRequest());
    expect(result.ok).toBe(true);
    // "a" should NOT have been called on third request
    expect(calls).toBe(callsAtOpen);
    router.dispose();
  });

  test("getMetrics() reflects totalRequests and failures", async () => {
    const adapters = new Map([
      [
        "a",
        makeAdapter("a", {
          completeWith: () => {
            throw new Error("down");
          },
        }),
      ],
      ["b", makeAdapter("b")],
    ]);
    const router = makeRouter(
      [
        { provider: "a", model: "m1" },
        { provider: "b", model: "m2" },
      ],
      adapters,
    );

    await router.route(makeRequest());
    const metrics = router.getMetrics();
    expect(metrics.totalRequests).toBe(1);
    router.dispose();
  });

  test("getHealth() returns snapshot for each target", () => {
    const adapters = new Map([["a", makeAdapter("a")]]);
    const router = makeRouter([{ provider: "a", model: "m1" }], adapters);
    const health = router.getHealth();
    expect(health.has("a:m1")).toBe(true);
    expect(health.get("a:m1")?.state).toBe("CLOSED");
    router.dispose();
  });

  test("throws on missing adapter for configured provider", () => {
    const configResult = validateRouterConfig({
      strategy: "fallback",
      targets: [{ provider: "missing", model: "m1", adapterConfig: {} }],
      retry: { maxRetries: 0 },
    });
    if (!configResult.ok) throw new Error();
    expect(() => createModelRouter(configResult.value, new Map())).toThrow("missing");
  });
});

// ---------------------------------------------------------------------------
// Streaming edge cases (Issue 11 in review)
// ---------------------------------------------------------------------------

describe("createModelRouter — routeStream() edge cases", () => {
  // Gap 1: sync throw before first chunk
  test("sync throw before first chunk → falls over to secondary", async () => {
    const adapters = new Map([
      ["a", makeAdapter("a", { streamError: new Error("sync-boom") })],
      ["b", makeAdapter("b", { streamWith: [{ kind: "text_delta", delta: "from-b" }] })],
    ]);
    const router = makeRouter(
      [
        { provider: "a", model: "m1" },
        { provider: "b", model: "m2" },
      ],
      adapters,
    );

    const chunks: ModelChunk[] = [];
    for await (const chunk of router.routeStream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.kind === "text_delta" && c.delta === "from-b")).toBe(true);
    router.dispose();
  });

  // Gap 2: mid-stream abort → throw propagates, no provider switch
  test("mid-stream failure after chunks yielded → propagates throw, never switches provider", async () => {
    const midStreamError = new Error("mid-stream-failure");
    const adapters = new Map([
      [
        "a",
        makeAdapter("a", {
          streamErrorAfterChunks: {
            chunks: [{ kind: "text_delta", delta: "partial" }],
            error: midStreamError,
          },
        }),
      ],
      ["b", makeAdapter("b", { streamWith: [{ kind: "text_delta", delta: "from-b" }] })],
    ]);
    const router = makeRouter(
      [
        { provider: "a", model: "m1" },
        { provider: "b", model: "m2" },
      ],
      adapters,
    );

    const collected: ModelChunk[] = [];
    let thrownError: unknown;

    try {
      for await (const chunk of router.routeStream(makeRequest())) {
        collected.push(chunk);
      }
    } catch (e) {
      thrownError = e;
    }

    // Should have received the partial chunk from "a"
    expect(collected.some((c) => c.kind === "text_delta" && c.delta === "partial")).toBe(true);
    // Should have thrown, not yielded chunks from "b"
    expect(thrownError).toBeDefined();
    expect(collected.some((c) => c.kind === "text_delta" && c.delta === "from-b")).toBe(false);
    router.dispose();
  });

  // Gap 3: all targets have open circuit breakers → yields error chunk
  test("all targets circuit-broken on stream → yields error chunk", async () => {
    const adapters = new Map([["a", makeAdapter("a", { streamError: new Error("down") })]]);

    const configResult = validateRouterConfig({
      strategy: "fallback",
      targets: [{ provider: "a", model: "m1", adapterConfig: {} }],
      retry: { maxRetries: 0 },
      circuitBreaker: {
        failureThreshold: 1,
        cooldownMs: 60_000,
        failureWindowMs: 60_000,
        failureStatusCodes: [500],
      },
    });
    if (!configResult.ok) throw new Error();
    const router = createModelRouter(configResult.value, adapters);

    // Manually open the circuit breaker by failing a non-stream call
    await router.route(makeRequest()); // fails, records failure → opens CB at threshold=1

    // Now streaming: CB is open → no targets to try → yields error chunk
    const chunks: ModelChunk[] = [];
    for await (const chunk of router.routeStream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.kind === "error")).toBe(true);
    router.dispose();
  });

  test("primary stream succeeds → yields all chunks", async () => {
    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "hello" },
      { kind: "text_delta", delta: " world" },
      { kind: "done", response: makeResponse("m1") },
    ];
    const adapters = new Map([["a", makeAdapter("a", { streamWith: chunks })]]);
    const router = makeRouter([{ provider: "a", model: "m1" }], adapters);

    const collected: ModelChunk[] = [];
    for await (const chunk of router.routeStream(makeRequest())) {
      collected.push(chunk);
    }

    expect(collected).toHaveLength(3);
    router.dispose();
  });
});
