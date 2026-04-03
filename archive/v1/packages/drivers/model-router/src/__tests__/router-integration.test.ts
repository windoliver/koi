/**
 * Integration tests for the full model-router pipeline.
 *
 * Tests the complete flow: config validation → router creation → routing with
 * retry, fallback, circuit breaker, and middleware adapter.
 *
 * Uses mock adapters (no real HTTP) — the goal is to verify correct wiring
 * between the layers, not individual layer behavior (covered by unit tests).
 */

import { describe, expect, mock, test } from "bun:test";
import type { KoiError, ModelRequest, ModelResponse } from "@koi/core";
import { validateRouterConfig } from "../config.js";
import { createModelRouterMiddleware } from "../middleware.js";
import type { ProviderAdapter, StreamChunk } from "../provider-adapter.js";
import { createModelRouter } from "../router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(text = "Hello"): ModelRequest {
  return {
    messages: [{ content: [{ kind: "text" as const, text }], senderId: "test-user", timestamp: 0 }],
  };
}

function makeResponse(content: string, model: string): ModelResponse {
  return { content, model, usage: { inputTokens: 10, outputTokens: 5 } };
}

function makeAdapter(
  id: string,
  completeFn: ProviderAdapter["complete"],
  streamFn?: ProviderAdapter["stream"],
): ProviderAdapter {
  return {
    id,
    complete: completeFn,
    stream:
      streamFn ??
      async function* () {
        yield { kind: "text_delta" as const, text: `streamed from ${id}` };
        yield { kind: "finish" as const, reason: "completed" };
      },
  };
}

// ---------------------------------------------------------------------------
// Full pipeline: config → router → route
// ---------------------------------------------------------------------------

describe("full pipeline integration", () => {
  test("validates config, creates router, and routes successfully", async () => {
    // Step 1: Validate config
    const configResult = validateRouterConfig({
      targets: [{ provider: "openai", model: "gpt-4o", adapterConfig: { apiKey: "sk-test-1" } }],
      strategy: "fallback",
    });

    expect(configResult.ok).toBe(true);
    if (!configResult.ok) throw new Error("Config validation failed");

    // Step 2: Create adapter
    const openaiAdapter = makeAdapter("openai", (req) => {
      const firstBlock = req.messages[0]?.content[0];
      const text = firstBlock?.kind === "text" ? firstBlock.text : "";
      return Promise.resolve(makeResponse(`Answer to: ${text}`, "gpt-4o"));
    });

    // Step 3: Create router
    const router = createModelRouter(configResult.value, new Map([["openai", openaiAdapter]]));

    // Step 4: Route
    const result = await router.route(makeRequest("What is 2+2?"));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Route failed");
    expect(result.value.content).toBe("Answer to: What is 2+2?");
    expect(result.value.model).toBe("gpt-4o");
  });

  test("multi-provider fallback with circuit breaker recovery", async () => {
    const configResult = validateRouterConfig({
      targets: [
        { provider: "openai", model: "gpt-4o", adapterConfig: { apiKey: "sk-test-1" } },
        { provider: "anthropic", model: "claude-sonnet", adapterConfig: { apiKey: "sk-test-2" } },
      ],
      strategy: "fallback",
      retry: { maxRetries: 0 }, // disable retries for speed
    });

    expect(configResult.ok).toBe(true);
    if (!configResult.ok) throw new Error("Config validation failed");

    let openaiCallCount = 0;
    const openaiAdapter = makeAdapter("openai", () => {
      openaiCallCount++;
      throw { code: "EXTERNAL", message: "OpenAI 500", retryable: false } satisfies KoiError;
    });

    const anthropicAdapter = makeAdapter("anthropic", () =>
      Promise.resolve(makeResponse("Anthropic response", "claude-sonnet")),
    );

    let currentTime = 0;
    const clock = () => currentTime;

    const router = createModelRouter(
      configResult.value,
      new Map([
        ["openai", openaiAdapter],
        ["anthropic", anthropicAdapter],
      ]),
      clock,
    );

    // Route 1: OpenAI fails, falls back to Anthropic
    const r1 = await router.route(makeRequest());
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error("Route 1 failed");
    expect(r1.value.content).toBe("Anthropic response");
    expect(openaiCallCount).toBe(1);

    // Check health: OpenAI should have a failure recorded
    const health1 = router.getHealth();
    expect(health1.get("openai:gpt-4o")?.failureCount).toBeGreaterThan(0);

    // After many failures, circuit breaker opens (threshold = 5 by default)
    for (let i = 0; i < 5; i++) {
      await router.route(makeRequest());
    }

    const health2 = router.getHealth();
    expect(health2.get("openai:gpt-4o")?.state).toBe("OPEN");

    // Record how many times OpenAI was called before circuit breaker blocks it
    const callsBefore = openaiCallCount;

    // Route again — should skip OpenAI (circuit breaker OPEN)
    const r3 = await router.route(makeRequest());
    expect(r3.ok).toBe(true);
    // OpenAI should not have been called
    expect(openaiCallCount).toBe(callsBefore);

    // Fast-forward past cooldown (60s default)
    currentTime = 61_000;

    // Route again — circuit breaker should transition to HALF_OPEN and try OpenAI
    const r4 = await router.route(makeRequest());
    expect(r4.ok).toBe(true);
    // OpenAI was tried again (probe in HALF_OPEN)
    expect(openaiCallCount).toBeGreaterThan(callsBefore);
  });

  test("metrics accumulate across multiple requests", async () => {
    const configResult = validateRouterConfig({
      targets: [{ provider: "openai", model: "gpt-4o", adapterConfig: { apiKey: "sk-test-1" } }],
      strategy: "fallback",
    });

    expect(configResult.ok).toBe(true);
    if (!configResult.ok) throw new Error("Config validation failed");

    const adapter = makeAdapter("openai", () => Promise.resolve(makeResponse("ok", "gpt-4o")));
    const router = createModelRouter(configResult.value, new Map([["openai", adapter]]));

    await router.route(makeRequest());
    await router.route(makeRequest());
    await router.route(makeRequest());

    const metrics = router.getMetrics();
    expect(metrics.totalRequests).toBe(3);
    expect(metrics.totalFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Middleware adapter integration
// ---------------------------------------------------------------------------

describe("middleware adapter integration", () => {
  test("middleware wrapModelCall routes through full pipeline", async () => {
    const configResult = validateRouterConfig({
      targets: [{ provider: "openai", model: "gpt-4o", adapterConfig: { apiKey: "sk-test-1" } }],
      strategy: "fallback",
    });

    expect(configResult.ok).toBe(true);
    if (!configResult.ok) throw new Error("Config validation failed");

    const adapter = makeAdapter("openai", () =>
      Promise.resolve(makeResponse("routed response", "gpt-4o")),
    );
    const router = createModelRouter(configResult.value, new Map([["openai", adapter]]));

    const middleware = createModelRouterMiddleware(router);

    expect(middleware.name).toBe("model-router");
    expect(middleware.priority).toBe(900);

    // Simulate middleware chain call
    if (!middleware.wrapModelCall) throw new Error("Expected wrapModelCall");
    const next = mock(() => Promise.resolve(makeResponse("next handler", "default")));
    const result = await middleware.wrapModelCall(
      {} as Parameters<typeof middleware.wrapModelCall>[0],
      makeRequest("Test"),
      next,
    );

    expect(result.content).toBe("routed response");
    expect(next).not.toHaveBeenCalled(); // middleware intercepts
  });

  test("middleware throws when all targets exhausted", async () => {
    const configResult = validateRouterConfig({
      targets: [{ provider: "openai", model: "gpt-4o", adapterConfig: { apiKey: "sk-test-1" } }],
      strategy: "fallback",
      retry: { maxRetries: 0 },
    });

    expect(configResult.ok).toBe(true);
    if (!configResult.ok) throw new Error("Config validation failed");

    const adapter = makeAdapter("openai", () => {
      throw { code: "EXTERNAL", message: "Server error", retryable: false } satisfies KoiError;
    });
    const router = createModelRouter(configResult.value, new Map([["openai", adapter]]));
    const middleware = createModelRouterMiddleware(router);

    if (!middleware.wrapModelCall) throw new Error("Expected wrapModelCall");
    try {
      await middleware.wrapModelCall(
        {} as Parameters<typeof middleware.wrapModelCall>[0],
        makeRequest("Test"),
        () => Promise.resolve(makeResponse("unused", "default")),
      );
      throw new Error("Should have thrown");
    } catch (e: unknown) {
      const err = e as KoiError;
      expect(err.code).toBe("EXTERNAL");
    }
  });
});

// ---------------------------------------------------------------------------
// Streaming integration
// ---------------------------------------------------------------------------

describe("streaming integration", () => {
  test("streams through router with fallback", async () => {
    const configResult = validateRouterConfig({
      targets: [
        { provider: "openai", model: "gpt-4o", adapterConfig: { apiKey: "sk-test-1" } },
        { provider: "anthropic", model: "claude-sonnet", adapterConfig: { apiKey: "sk-test-2" } },
      ],
      strategy: "fallback",
    });

    expect(configResult.ok).toBe(true);
    if (!configResult.ok) throw new Error("Config validation failed");

    // OpenAI stream fails
    const openaiAdapter = makeAdapter(
      "openai",
      () => Promise.resolve(makeResponse("ok", "gpt-4o")),
      // biome-ignore lint/correctness/useYield: intentionally models a stream that fails before yielding
      async function* () {
        throw new Error("stream error");
      },
    );

    // Anthropic stream succeeds
    const anthropicAdapter = makeAdapter(
      "anthropic",
      () => Promise.resolve(makeResponse("ok", "claude")),
      async function* () {
        yield { kind: "text_delta" as const, text: "Hello " };
        yield { kind: "text_delta" as const, text: "world" };
        yield { kind: "finish" as const, reason: "completed" };
      },
    );

    const router = createModelRouter(
      configResult.value,
      new Map([
        ["openai", openaiAdapter],
        ["anthropic", anthropicAdapter],
      ]),
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of router.routeStream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.kind).toBe("text_delta");
    if (chunks[0]?.kind === "text_delta") {
      expect(chunks[0].text).toBe("Hello ");
    }
    expect(chunks[2]?.kind).toBe("finish");
  });
});
