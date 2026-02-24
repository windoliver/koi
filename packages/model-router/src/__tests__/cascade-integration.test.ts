/**
 * Integration tests for cascade routing strategy.
 *
 * Tests end-to-end flows through the router with cascade config,
 * including multi-tier escalation, circuit breaker interaction,
 * and middleware integration.
 */

import { describe, expect, mock, test } from "bun:test";
import type { KoiError, ModelRequest, ModelResponse } from "@koi/core";
import type { CascadeEvaluator, ResolvedCascadeConfig } from "../cascade/cascade-types.js";
import { createKeywordEvaluator } from "../cascade/evaluators.js";
import type { ResolvedRouterConfig, ResolvedTargetConfig } from "../config.js";
import { createModelRouterMiddleware } from "../middleware.js";
import type { ProviderAdapter } from "../provider-adapter.js";
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
  return { content, model, usage: { inputTokens: 100, outputTokens: 50 } };
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

function makeCascadeConfig(
  targets: readonly ResolvedTargetConfig[],
  cascadeOverrides?: Partial<ResolvedCascadeConfig>,
): ResolvedRouterConfig {
  const targetIds = targets.map((t) => `${t.provider}:${t.model}`);
  return {
    targets,
    strategy: "cascade",
    retry: {
      maxRetries: 0,
      backoffMultiplier: 2,
      initialDelayMs: 10,
      maxBackoffMs: 100,
      jitter: false,
    },
    circuitBreaker: {
      failureThreshold: 2,
      cooldownMs: 60_000,
      failureWindowMs: 60_000,
      failureStatusCodes: [429, 500, 502, 503, 504],
    },
    cascade: {
      tiers: targetIds.map((id) => ({ targetId: id })),
      confidenceThreshold: 0.7,
      maxEscalations: targetIds.length - 1,
      budgetLimitTokens: 0,
      evaluatorTimeoutMs: 5_000,
      ...cascadeOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Full 3-tier cascade
// ---------------------------------------------------------------------------

describe("cascade integration: full 3-tier", () => {
  test("cheap model low confidence → medium model accepted", async () => {
    const evaluator: CascadeEvaluator = (_req, response) => {
      // Cheap model → low confidence, medium model → high confidence
      if (response.content.includes("cheap")) {
        return { confidence: 0.3, reason: "Cheap model response too brief" };
      }
      return { confidence: 0.85, reason: "Medium model adequate" };
    };

    const targets = [
      makeTarget("cheap-provider", "cheap-model"),
      makeTarget("medium-provider", "medium-model"),
      makeTarget("expensive-provider", "expensive-model"),
    ];

    const cheapAdapter: ProviderAdapter = {
      id: "cheap-provider",
      complete: mock(() => Promise.resolve(makeResponse("cheap answer", "cheap-model"))),
      async *stream() {
        yield { kind: "finish" as const, reason: "done" };
      },
    };
    const mediumAdapter: ProviderAdapter = {
      id: "medium-provider",
      complete: mock(() => Promise.resolve(makeResponse("detailed medium answer", "medium-model"))),
      async *stream() {
        yield { kind: "finish" as const, reason: "done" };
      },
    };
    const expensiveAdapter: ProviderAdapter = {
      id: "expensive-provider",
      complete: mock(() => Promise.resolve(makeResponse("expensive answer", "expensive-model"))),
      async *stream() {
        yield { kind: "finish" as const, reason: "done" };
      },
    };

    const adapters = new Map<string, ProviderAdapter>([
      ["cheap-provider", cheapAdapter],
      ["medium-provider", mediumAdapter],
      ["expensive-provider", expensiveAdapter],
    ]);

    const config = makeCascadeConfig(targets);
    const router = createModelRouter(config, adapters, { evaluator });

    const result = await router.route(makeRequest("What is 2+2?"));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.content).toBe("detailed medium answer");
    expect(result.value.model).toBe("medium-model");

    // Verify only 2 adapters were called (cheap + medium, NOT expensive)
    expect(cheapAdapter.complete).toHaveBeenCalledTimes(1);
    expect(mediumAdapter.complete).toHaveBeenCalledTimes(1);
    expect(expensiveAdapter.complete).not.toHaveBeenCalled();

    // Verify metrics
    const metrics = router.getMetrics();
    expect(metrics.totalRequests).toBe(1);
    expect(metrics.totalFailures).toBe(0);
    expect(metrics.cascade).toBeDefined();
    expect(metrics.cascade?.totalEscalations).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Cascade with circuit breaker
// ---------------------------------------------------------------------------

describe("cascade integration: circuit breaker", () => {
  test("circuit-broken cheap tier skips to medium directly", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.9 });
    const failFn = () => {
      throw { code: "EXTERNAL", message: "down", retryable: false } satisfies KoiError;
    };

    const targets = [
      makeTarget("cheap-provider", "cheap-model"),
      makeTarget("medium-provider", "medium-model"),
    ];

    const cheapAdapter: ProviderAdapter = {
      id: "cheap-provider",
      complete: mock(failFn),
      async *stream() {
        yield { kind: "finish" as const, reason: "done" };
      },
    };
    const mediumAdapter: ProviderAdapter = {
      id: "medium-provider",
      complete: mock(() => Promise.resolve(makeResponse("medium ok", "medium-model"))),
      async *stream() {
        yield { kind: "finish" as const, reason: "done" };
      },
    };

    const adapters = new Map<string, ProviderAdapter>([
      ["cheap-provider", cheapAdapter],
      ["medium-provider", mediumAdapter],
    ]);

    const config = makeCascadeConfig(targets);
    const router = createModelRouter(config, adapters, { evaluator });

    // First two calls: cheap fails, falls through to medium
    await router.route(makeRequest());
    await router.route(makeRequest());

    // After 2 failures, circuit breaker opens for cheap tier
    const health = router.getHealth();
    expect(health.get("cheap-provider:cheap-model")?.state).toBe("OPEN");

    // Reset call counts
    (cheapAdapter.complete as ReturnType<typeof mock>).mockClear();
    (mediumAdapter.complete as ReturnType<typeof mock>).mockClear();

    // Third call: cheap tier should be skipped by circuit breaker
    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.content).toBe("medium ok");

    // Cheap adapter should NOT have been called (circuit breaker is OPEN)
    expect(cheapAdapter.complete).not.toHaveBeenCalled();
    expect(mediumAdapter.complete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Cascade via middleware
// ---------------------------------------------------------------------------

describe("cascade integration: middleware", () => {
  test("createModelRouterMiddleware with cascade strategy works end-to-end", async () => {
    const evaluator = createKeywordEvaluator();

    const targets = [makeTarget("openai", "gpt-4o-mini"), makeTarget("openai", "gpt-4o")];

    const adapter: ProviderAdapter = {
      id: "openai",
      complete: mock((req: ModelRequest) => {
        if (req.model === "gpt-4o-mini") {
          // Cheap model: uncertain response → low confidence from keyword evaluator
          return Promise.resolve(
            makeResponse("I'm not sure, it depends on context", "gpt-4o-mini"),
          );
        }
        // Expensive model: confident response
        return Promise.resolve(makeResponse("The answer is definitively 42", "gpt-4o"));
      }),
      async *stream() {
        yield { kind: "finish" as const, reason: "done" };
      },
    };

    const adapters = new Map<string, ProviderAdapter>([["openai", adapter]]);

    const config = makeCascadeConfig(targets);
    const router = createModelRouter(config, adapters, { evaluator });
    const mw = createModelRouterMiddleware(router);

    expect(mw.name).toBe("model-router");

    if (!mw.wrapModelCall) throw new Error("Expected wrapModelCall");
    const next = mock(() => Promise.resolve(makeResponse("unused", "unused")));

    const result = await mw.wrapModelCall(
      {} as Parameters<typeof mw.wrapModelCall>[0],
      makeRequest("What is 2+2?"),
      next,
    );

    // The keyword evaluator should detect "I'm not sure" and "it depends" → low confidence
    // → escalate to gpt-4o (last tier, accepted without evaluation)
    expect(result.content).toBe("The answer is definitively 42");
    expect(result.model).toBe("gpt-4o");
    expect(next).not.toHaveBeenCalled();
  });
});
