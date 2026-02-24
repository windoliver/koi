import { describe, expect, mock, test } from "bun:test";
import type { KoiError, ModelRequest, ModelResponse } from "@koi/core";
import type { ResolvedRouterConfig, ResolvedTargetConfig } from "./config.js";
import type { ProviderAdapter, StreamChunk } from "./provider-adapter.js";
import { createModelRouter } from "./router.js";

// ---------------------------------------------------------------------------
// Helpers
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
    adapterConfig: { apiKey: "sk-test" },
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
      maxRetries: 0, // no retries in unit tests by default (faster)
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
// createModelRouter — construction
// ---------------------------------------------------------------------------

describe("createModelRouter", () => {
  test("throws when adapter is missing for a configured provider", () => {
    const config = makeConfig([makeTarget("openai", "gpt-4o")]);
    const adapters = new Map<string, ProviderAdapter>();

    expect(() => createModelRouter(config, adapters)).toThrow(
      'No adapter registered for provider "openai"',
    );
  });

  test("creates router when all adapters present", () => {
    const config = makeConfig([makeTarget("openai", "gpt-4o")]);
    const adapter = makeAdapter("openai", () => Promise.resolve(makeResponse("hi", "gpt-4o")));
    const adapters = new Map([["openai", adapter]]);

    const router = createModelRouter(config, adapters);
    expect(router.route).toBeFunction();
    expect(router.routeStream).toBeFunction();
    expect(router.getHealth).toBeFunction();
    expect(router.getMetrics).toBeFunction();
    expect(router.dispose).toBeFunction();
  });
});

// ---------------------------------------------------------------------------
// route — happy path
// ---------------------------------------------------------------------------

describe("route", () => {
  test("routes to primary target and returns response", async () => {
    const config = makeConfig([makeTarget("openai", "gpt-4o")]);
    const completeFn = mock(() => Promise.resolve(makeResponse("Hello!", "gpt-4o")));
    const adapter = makeAdapter("openai", completeFn);
    const router = createModelRouter(config, new Map([["openai", adapter]]));

    const result = await router.route(makeRequest("Hi"));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.content).toBe("Hello!");
    expect(result.value.model).toBe("gpt-4o");
    expect(completeFn).toHaveBeenCalledTimes(1);
  });

  test("passes model from target config, not from request", async () => {
    const config = makeConfig([makeTarget("openai", "gpt-4o-mini")]);
    const completeFn = mock((req: ModelRequest) => {
      expect(req.model).toBe("gpt-4o-mini");
      return Promise.resolve(makeResponse("ok", "gpt-4o-mini"));
    });
    const adapter = makeAdapter("openai", completeFn);
    const router = createModelRouter(config, new Map([["openai", adapter]]));

    const result = await router.route({
      messages: [
        { content: [{ kind: "text" as const, text: "test" }], senderId: "test-user", timestamp: 0 },
      ],
      model: "gpt-3.5",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.model).toBe("gpt-4o-mini");
  });

  // ---------------------------------------------------------------------------
  // route — fallback
  // ---------------------------------------------------------------------------

  test("falls back to second target when first fails", async () => {
    const primaryFn = mock(() => {
      throw { code: "EXTERNAL", message: "OpenAI down", retryable: false } satisfies KoiError;
    });
    const fallbackFn = mock(() => Promise.resolve(makeResponse("Anthropic ok", "claude")));

    const config = makeConfig([makeTarget("openai", "gpt-4o"), makeTarget("anthropic", "claude")]);
    const adapters = new Map<string, ProviderAdapter>([
      ["openai", makeAdapter("openai", primaryFn)],
      ["anthropic", makeAdapter("anthropic", fallbackFn)],
    ]);
    const router = createModelRouter(config, adapters);

    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.content).toBe("Anthropic ok");
    expect(primaryFn).toHaveBeenCalledTimes(1);
    expect(fallbackFn).toHaveBeenCalledTimes(1);
  });

  test("returns error when all targets fail", async () => {
    const failFn = () => {
      throw { code: "EXTERNAL", message: "down", retryable: false } satisfies KoiError;
    };

    const config = makeConfig([makeTarget("openai", "gpt-4o"), makeTarget("anthropic", "claude")]);
    const adapters = new Map<string, ProviderAdapter>([
      ["openai", makeAdapter("openai", failFn)],
      ["anthropic", makeAdapter("anthropic", failFn)],
    ]);
    const router = createModelRouter(config, adapters);

    const result = await router.route(makeRequest());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("EXTERNAL");
    expect(result.error.message).toContain("All");
  });

  test("skips disabled targets", async () => {
    const disabledFn = mock(() => Promise.resolve(makeResponse("should not be called", "gpt-4o")));
    const enabledFn = mock(() => Promise.resolve(makeResponse("enabled", "claude")));

    const config = makeConfig([
      makeTarget("openai", "gpt-4o", { enabled: false }),
      makeTarget("anthropic", "claude"),
    ]);
    const adapters = new Map<string, ProviderAdapter>([
      ["openai", makeAdapter("openai", disabledFn)],
      ["anthropic", makeAdapter("anthropic", enabledFn)],
    ]);
    const router = createModelRouter(config, adapters);

    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.content).toBe("enabled");
    expect(disabledFn).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // route — circuit breaker integration
  // ---------------------------------------------------------------------------

  test("circuit breaker opens after repeated failures", async () => {
    let callCount = 0;
    const failFn = mock(() => {
      callCount++;
      throw { code: "EXTERNAL", message: `fail ${callCount}`, retryable: false } satisfies KoiError;
    });
    const fallbackFn = mock(() => Promise.resolve(makeResponse("fallback", "claude")));

    const config = makeConfig([makeTarget("openai", "gpt-4o"), makeTarget("anthropic", "claude")], {
      circuitBreaker: {
        failureThreshold: 2,
        cooldownMs: 60_000,
        failureWindowMs: 60_000,
        failureStatusCodes: [429, 500, 502, 503, 504],
      },
    });
    const adapters = new Map<string, ProviderAdapter>([
      ["openai", makeAdapter("openai", failFn)],
      ["anthropic", makeAdapter("anthropic", fallbackFn)],
    ]);
    const router = createModelRouter(config, adapters);

    // First two calls: openai fails, then falls back to anthropic
    await router.route(makeRequest());
    await router.route(makeRequest());

    // After 2 failures, circuit breaker should open for openai
    const health = router.getHealth();
    const openaiHealth = health.get("openai:gpt-4o");
    expect(openaiHealth?.state).toBe("OPEN");

    // Third call: should skip openai entirely and go straight to anthropic
    const prevCallCount = failFn.mock.calls.length;
    await router.route(makeRequest());

    // openai should not have been called again (circuit breaker is OPEN)
    expect(failFn.mock.calls.length).toBe(prevCallCount);
  });
});

// ---------------------------------------------------------------------------
// routeStream
// ---------------------------------------------------------------------------

describe("routeStream", () => {
  test("streams from primary target", async () => {
    const config = makeConfig([makeTarget("openai", "gpt-4o")]);
    const adapter = makeAdapter("openai", () => Promise.resolve(makeResponse("hi", "gpt-4o")));
    const router = createModelRouter(config, new Map([["openai", adapter]]));

    const chunks: StreamChunk[] = [];
    for await (const chunk of router.routeStream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.kind).toBe("text_delta");
    expect(chunks[1]?.kind).toBe("finish");
  });

  test("falls back to next target when stream throws", async () => {
    // biome-ignore lint/correctness/useYield: intentionally models a stream that fails before yielding
    async function* failStream(): AsyncGenerator<StreamChunk> {
      throw new Error("stream failed");
    }
    async function* okStream(): AsyncGenerator<StreamChunk> {
      yield { kind: "text_delta", text: "from fallback" };
      yield { kind: "finish", reason: "completed" };
    }

    const config = makeConfig([makeTarget("openai", "gpt-4o"), makeTarget("anthropic", "claude")]);
    const adapters = new Map<string, ProviderAdapter>([
      [
        "openai",
        makeStreamAdapter("openai", () => Promise.resolve(makeResponse("", "gpt-4o")), failStream),
      ],
      [
        "anthropic",
        makeStreamAdapter("anthropic", () => Promise.resolve(makeResponse("", "claude")), okStream),
      ],
    ]);
    const router = createModelRouter(config, adapters);

    const chunks: StreamChunk[] = [];
    for await (const chunk of router.routeStream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.kind).toBe("text_delta");
    if (chunks[0]?.kind === "text_delta") {
      expect(chunks[0].text).toBe("from fallback");
    }
  });

  test("yields error when all stream targets fail", async () => {
    // biome-ignore lint/correctness/useYield: intentionally models a stream that fails before yielding
    async function* failStream(): AsyncGenerator<StreamChunk> {
      throw new Error("down");
    }

    const config = makeConfig([makeTarget("openai", "gpt-4o")]);
    const adapters = new Map<string, ProviderAdapter>([
      [
        "openai",
        makeStreamAdapter("openai", () => Promise.resolve(makeResponse("", "gpt-4o")), failStream),
      ],
    ]);
    const router = createModelRouter(config, adapters);

    const chunks: StreamChunk[] = [];
    for await (const chunk of router.routeStream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("error");
    if (chunks[0]?.kind === "error") {
      expect(chunks[0].message).toContain("All streaming targets failed");
    }
  });
});

// ---------------------------------------------------------------------------
// getHealth
// ---------------------------------------------------------------------------

describe("getHealth", () => {
  test("returns circuit breaker snapshots for all targets", () => {
    const config = makeConfig([makeTarget("openai", "gpt-4o"), makeTarget("anthropic", "claude")]);
    const adapters = new Map<string, ProviderAdapter>([
      ["openai", makeAdapter("openai", () => Promise.resolve(makeResponse("ok", "gpt-4o")))],
      ["anthropic", makeAdapter("anthropic", () => Promise.resolve(makeResponse("ok", "claude")))],
    ]);
    const router = createModelRouter(config, adapters);

    const health = router.getHealth();

    expect(health.size).toBe(2);
    expect(health.has("openai:gpt-4o")).toBe(true);
    expect(health.has("anthropic:claude")).toBe(true);

    const snapshot = health.get("openai:gpt-4o");
    expect(snapshot?.state).toBe("CLOSED");
    expect(snapshot?.failureCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getMetrics
// ---------------------------------------------------------------------------

describe("getMetrics", () => {
  test("starts at zero", () => {
    const config = makeConfig([makeTarget("openai", "gpt-4o")]);
    const adapter = makeAdapter("openai", () => Promise.resolve(makeResponse("hi", "gpt-4o")));
    const router = createModelRouter(config, new Map([["openai", adapter]]));

    const metrics = router.getMetrics();

    expect(metrics.totalRequests).toBe(0);
    expect(metrics.totalFailures).toBe(0);
    expect(Object.keys(metrics.requestsByTarget)).toHaveLength(0);
  });

  test("tracks successful requests", async () => {
    const config = makeConfig([makeTarget("openai", "gpt-4o")]);
    const adapter = makeAdapter("openai", () => Promise.resolve(makeResponse("hi", "gpt-4o")));
    const router = createModelRouter(config, new Map([["openai", adapter]]));

    await router.route(makeRequest());
    await router.route(makeRequest());

    const metrics = router.getMetrics();

    expect(metrics.totalRequests).toBe(2);
    expect(metrics.totalFailures).toBe(0);
    expect(metrics.requestsByTarget["openai:gpt-4o"]).toBe(2);
  });

  test("tracks failures when all targets fail", async () => {
    const config = makeConfig([makeTarget("openai", "gpt-4o")]);
    const failFn = () => {
      throw { code: "EXTERNAL", message: "down", retryable: false } satisfies KoiError;
    };
    const adapter = makeAdapter("openai", failFn);
    const router = createModelRouter(config, new Map([["openai", adapter]]));

    await router.route(makeRequest());

    const metrics = router.getMetrics();

    expect(metrics.totalRequests).toBe(1);
    expect(metrics.totalFailures).toBe(1);
  });

  test("returns metrics snapshot (not a live reference)", async () => {
    const config = makeConfig([makeTarget("openai", "gpt-4o")]);
    const adapter = makeAdapter("openai", () => Promise.resolve(makeResponse("hi", "gpt-4o")));
    const router = createModelRouter(config, new Map([["openai", adapter]]));

    const before = router.getMetrics();
    expect(before.totalRequests).toBe(0);

    await router.route(makeRequest());

    // The snapshot taken before should not reflect the new request
    expect(before.totalRequests).toBe(0);
    const after = router.getMetrics();
    expect(after.totalRequests).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  test("resets all circuit breakers to CLOSED", async () => {
    const failFn = () => {
      throw { code: "EXTERNAL", message: "fail", retryable: false } satisfies KoiError;
    };
    const fallbackFn = () => Promise.resolve(makeResponse("ok", "claude"));

    const config = makeConfig([makeTarget("openai", "gpt-4o"), makeTarget("anthropic", "claude")], {
      circuitBreaker: {
        failureThreshold: 1,
        cooldownMs: 60_000,
        failureWindowMs: 60_000,
        failureStatusCodes: [429, 500, 502, 503, 504],
      },
    });
    const adapters = new Map<string, ProviderAdapter>([
      ["openai", makeAdapter("openai", failFn)],
      ["anthropic", makeAdapter("anthropic", fallbackFn)],
    ]);
    const router = createModelRouter(config, adapters);

    // Trigger failure to open circuit breaker
    await router.route(makeRequest());
    const healthBefore = router.getHealth();
    expect(healthBefore.get("openai:gpt-4o")?.state).toBe("OPEN");

    // Dispose resets
    router.dispose();

    const healthAfter = router.getHealth();
    expect(healthAfter.get("openai:gpt-4o")?.state).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// cascade strategy — see router-cascade.test.ts for full cascade tests
// ---------------------------------------------------------------------------
