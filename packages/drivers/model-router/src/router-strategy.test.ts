/**
 * Integration tests for round-robin and weighted routing strategies.
 * Tests the full router pipeline with strategy-aware target ordering.
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, ModelRequest, ModelResponse } from "@koi/core";
import type { ResolvedRouterConfig, ResolvedTargetConfig } from "./config.js";
import type { ProviderAdapter, StreamChunk } from "./provider-adapter.js";
import { createModelRouter } from "./router.js";

// ---------------------------------------------------------------------------
// Helpers (duplicated from router.test.ts — colocated for independence)
// ---------------------------------------------------------------------------

function makeRequest(text = "Hello"): ModelRequest {
  return {
    messages: [{ content: [{ kind: "text" as const, text }], senderId: "test-user", timestamp: 0 }],
  };
}

function makeResponse(content: string, model = "test-model"): ModelResponse {
  return { content, model };
}

function makeTarget(
  provider: string,
  model: string,
  overrides?: Partial<ResolvedTargetConfig>,
): ResolvedTargetConfig {
  return {
    provider,
    model,
    weight: 1,
    enabled: true,
    adapterConfig: { apiKey: "test-key-not-real" },
    ...overrides,
  };
}

function makeConfig(
  targets: readonly ResolvedTargetConfig[],
  overrides?: Partial<ResolvedRouterConfig>,
): ResolvedRouterConfig {
  return {
    targets,
    strategy: "fallback",
    retry: {
      maxRetries: 0,
      backoffMultiplier: 2,
      initialDelayMs: 10,
      maxBackoffMs: 100,
      jitter: false,
    },
    circuitBreaker: {
      failureThreshold: 3,
      cooldownMs: 10_000,
      failureWindowMs: 10_000,
      failureStatusCodes: [429, 500, 502, 503, 504],
    },
    ...overrides,
  };
}

function makeAdapter(id: string, completeFn: ProviderAdapter["complete"]): ProviderAdapter {
  return {
    id,
    complete: completeFn,
    async *stream(_request: ModelRequest): AsyncGenerator<StreamChunk> {
      yield { kind: "text_delta", text: "streamed" };
      yield { kind: "finish", reason: "completed" };
    },
  };
}

function makeStreamAdapter(
  id: string,
  completeFn: ProviderAdapter["complete"],
  streamFn: ProviderAdapter["stream"],
): ProviderAdapter {
  return { id, complete: completeFn, stream: streamFn };
}

// ---------------------------------------------------------------------------
// round-robin strategy
// ---------------------------------------------------------------------------

describe("round-robin strategy", () => {
  test("distributes requests across targets", async () => {
    const hitOrder: string[] = [];

    const openaiAdapter = makeAdapter("openai", () => {
      hitOrder.push("openai:gpt-4o");
      return Promise.resolve(makeResponse("openai", "gpt-4o"));
    });
    const anthropicAdapter = makeAdapter("anthropic", () => {
      hitOrder.push("anthropic:claude");
      return Promise.resolve(makeResponse("anthropic", "claude"));
    });

    const config = makeConfig([makeTarget("openai", "gpt-4o"), makeTarget("anthropic", "claude")], {
      strategy: "round-robin",
    });
    const adapters = new Map<string, ProviderAdapter>([
      ["openai", openaiAdapter],
      ["anthropic", anthropicAdapter],
    ]);
    const router = createModelRouter(config, adapters);

    // Call 0 → openai first, call 1 → anthropic first, call 2 → openai first
    await router.route(makeRequest());
    await router.route(makeRequest());
    await router.route(makeRequest());

    // First hit of each request cycles through targets
    expect(hitOrder[0]).toBe("openai:gpt-4o");
    expect(hitOrder[1]).toBe("anthropic:claude");
    expect(hitOrder[2]).toBe("openai:gpt-4o");
  });

  test("falls back on primary failure", async () => {
    // let: call counter for alternating behavior
    let openaiCalls = 0;

    const openaiAdapter = makeAdapter("openai", () => {
      openaiCalls++;
      throw { code: "EXTERNAL", message: "down", retryable: false } satisfies KoiError;
    });
    const anthropicAdapter = makeAdapter("anthropic", () =>
      Promise.resolve(makeResponse("anthropic", "claude")),
    );

    const config = makeConfig([makeTarget("openai", "gpt-4o"), makeTarget("anthropic", "claude")], {
      strategy: "round-robin",
    });
    const adapters = new Map<string, ProviderAdapter>([
      ["openai", openaiAdapter],
      ["anthropic", anthropicAdapter],
    ]);
    const router = createModelRouter(config, adapters);

    // Round 0: openai is primary but fails → falls back to anthropic
    const result = await router.route(makeRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.model).toBe("claude");
    expect(openaiCalls).toBe(1);
  });

  test("stream path respects round-robin ordering", async () => {
    const streamOrder: string[] = [];

    async function* openaiStream(): AsyncGenerator<StreamChunk> {
      streamOrder.push("openai");
      yield { kind: "text_delta", text: "openai" };
      yield { kind: "finish", reason: "completed" };
    }
    async function* anthropicStream(): AsyncGenerator<StreamChunk> {
      streamOrder.push("anthropic");
      yield { kind: "text_delta", text: "anthropic" };
      yield { kind: "finish", reason: "completed" };
    }

    const config = makeConfig([makeTarget("openai", "gpt-4o"), makeTarget("anthropic", "claude")], {
      strategy: "round-robin",
    });
    const adapters = new Map<string, ProviderAdapter>([
      [
        "openai",
        makeStreamAdapter(
          "openai",
          () => Promise.resolve(makeResponse("", "gpt-4o")),
          openaiStream,
        ),
      ],
      [
        "anthropic",
        makeStreamAdapter(
          "anthropic",
          () => Promise.resolve(makeResponse("", "claude")),
          anthropicStream,
        ),
      ],
    ]);
    const router = createModelRouter(config, adapters);

    // First stream → openai is primary
    const chunks1: StreamChunk[] = [];
    for await (const chunk of router.routeStream(makeRequest())) {
      chunks1.push(chunk);
    }
    expect(streamOrder[0]).toBe("openai");

    // Second stream → anthropic is primary
    const chunks2: StreamChunk[] = [];
    for await (const chunk of router.routeStream(makeRequest())) {
      chunks2.push(chunk);
    }
    expect(streamOrder[1]).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// weighted strategy
// ---------------------------------------------------------------------------

describe("weighted strategy", () => {
  test("selects target based on weight and random", async () => {
    const config = makeConfig(
      [
        makeTarget("openai", "gpt-4o", { weight: 0.2 }),
        makeTarget("anthropic", "claude", { weight: 0.8 }),
      ],
      { strategy: "weighted" },
    );
    const adapters = new Map<string, ProviderAdapter>([
      ["openai", makeAdapter("openai", () => Promise.resolve(makeResponse("openai", "gpt-4o")))],
      [
        "anthropic",
        makeAdapter("anthropic", () => Promise.resolve(makeResponse("anthropic", "claude"))),
      ],
    ]);

    // random = 0.5 → roll = 0.5 * 1.0 = 0.5 → openai range [0, 0.2), anthropic [0.2, 1.0)
    // → selects anthropic
    const router = createModelRouter(config, adapters, { random: () => 0.5 });
    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.model).toBe("claude");
  });

  test("selects low-weight target when random is low", async () => {
    const config = makeConfig(
      [
        makeTarget("openai", "gpt-4o", { weight: 0.2 }),
        makeTarget("anthropic", "claude", { weight: 0.8 }),
      ],
      { strategy: "weighted" },
    );
    const adapters = new Map<string, ProviderAdapter>([
      ["openai", makeAdapter("openai", () => Promise.resolve(makeResponse("openai", "gpt-4o")))],
      [
        "anthropic",
        makeAdapter("anthropic", () => Promise.resolve(makeResponse("anthropic", "claude"))),
      ],
    ]);

    // random = 0.1 → roll = 0.1 * 1.0 = 0.1 → falls in openai range [0, 0.2)
    const router = createModelRouter(config, adapters, { random: () => 0.1 });
    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.model).toBe("gpt-4o");
  });

  test("falls back when weighted primary fails", async () => {
    const config = makeConfig(
      [
        makeTarget("openai", "gpt-4o", { weight: 0.8 }),
        makeTarget("anthropic", "claude", { weight: 0.2 }),
      ],
      { strategy: "weighted" },
    );
    const adapters = new Map<string, ProviderAdapter>([
      [
        "openai",
        makeAdapter("openai", () => {
          throw { code: "EXTERNAL", message: "down", retryable: false } satisfies KoiError;
        }),
      ],
      [
        "anthropic",
        makeAdapter("anthropic", () => Promise.resolve(makeResponse("anthropic", "claude"))),
      ],
    ]);

    // random = 0.1 → selects openai (weight 0.8, range [0, 0.8)), which fails
    // → falls back to anthropic
    const router = createModelRouter(config, adapters, { random: () => 0.1 });
    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.model).toBe("claude");
  });

  test("stream path respects weighted ordering", async () => {
    const streamOrder: string[] = [];

    async function* openaiStream(): AsyncGenerator<StreamChunk> {
      streamOrder.push("openai");
      yield { kind: "text_delta", text: "openai" };
      yield { kind: "finish", reason: "completed" };
    }
    async function* anthropicStream(): AsyncGenerator<StreamChunk> {
      streamOrder.push("anthropic");
      yield { kind: "text_delta", text: "anthropic" };
      yield { kind: "finish", reason: "completed" };
    }

    const config = makeConfig(
      [
        makeTarget("openai", "gpt-4o", { weight: 0.2 }),
        makeTarget("anthropic", "claude", { weight: 0.8 }),
      ],
      { strategy: "weighted" },
    );
    const adapters = new Map<string, ProviderAdapter>([
      [
        "openai",
        makeStreamAdapter(
          "openai",
          () => Promise.resolve(makeResponse("", "gpt-4o")),
          openaiStream,
        ),
      ],
      [
        "anthropic",
        makeStreamAdapter(
          "anthropic",
          () => Promise.resolve(makeResponse("", "claude")),
          anthropicStream,
        ),
      ],
    ]);

    // random = 0.5 → selects anthropic as primary
    const router = createModelRouter(config, adapters, { random: () => 0.5 });

    const chunks: StreamChunk[] = [];
    for await (const chunk of router.routeStream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(streamOrder[0]).toBe("anthropic");
  });
});
