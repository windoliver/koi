/**
 * Tests for cascade strategy routing, including pre-request classifier integration.
 * Extracted from router.test.ts to stay under the 800-line file limit.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ModelRequest, ModelResponse } from "@koi/core";
import type { CascadeClassifier, CascadeEvaluator } from "./cascade/cascade-types.js";
import type { ResolvedRouterConfig, ResolvedTargetConfig } from "./config.js";
import type { ProviderAdapter, StreamChunk } from "./provider-adapter.js";
import { createModelRouter } from "./router.js";

// ---------------------------------------------------------------------------
// Helpers (shared with router.test.ts — duplicated to keep files independent)
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

// ---------------------------------------------------------------------------
// Cascade strategy tests
// ---------------------------------------------------------------------------

describe("cascade strategy", () => {
  function makeCascadeConfig(
    targets: readonly ResolvedTargetConfig[],
    overrides?: Partial<ResolvedRouterConfig>,
  ): ResolvedRouterConfig {
    const targetIds = targets.map((t) => `${t.provider}:${t.model}`);
    return makeConfig(targets, {
      strategy: "cascade",
      cascade: {
        tiers: targetIds.map((id) => ({ targetId: id })),
        confidenceThreshold: 0.7,
        maxEscalations: targetIds.length - 1,
        budgetLimitTokens: 0,
        evaluatorTimeoutMs: 5_000,
      },
      ...overrides,
    });
  }

  test("routes to cheapest tier first when confidence is high", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.9 });
    const cheapFn = mock((_req: ModelRequest) =>
      Promise.resolve(makeResponse("cheap answer", "gpt-4o-mini")),
    );
    const expensiveFn = mock((_req: ModelRequest) =>
      Promise.resolve(makeResponse("expensive answer", "gpt-4o")),
    );

    const config = makeCascadeConfig([
      makeTarget("openai", "gpt-4o-mini"),
      makeTarget("openai", "gpt-4o"),
    ]);
    const adapters = new Map<string, ProviderAdapter>([
      [
        "openai",
        makeAdapter("openai", (req: ModelRequest) => {
          if (req.model === "gpt-4o-mini") return cheapFn(req);
          return expensiveFn(req);
        }),
      ],
    ]);

    const router = createModelRouter(config, adapters, { evaluator });
    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.content).toBe("cheap answer");
    expect(cheapFn).toHaveBeenCalledTimes(1);
    expect(expensiveFn).not.toHaveBeenCalled();
  });

  test("escalates when evaluator returns low confidence", async () => {
    let evalCount = 0;
    const evaluator: CascadeEvaluator = () => {
      evalCount++;
      return { confidence: evalCount === 1 ? 0.2 : 0.9 };
    };

    const config = makeCascadeConfig([
      makeTarget("openai", "gpt-4o-mini"),
      makeTarget("anthropic", "claude"),
    ]);
    const adapters = new Map<string, ProviderAdapter>([
      [
        "openai",
        makeAdapter("openai", () => Promise.resolve(makeResponse("cheap", "gpt-4o-mini"))),
      ],
      [
        "anthropic",
        makeAdapter("anthropic", () => Promise.resolve(makeResponse("expensive", "claude"))),
      ],
    ]);

    const router = createModelRouter(config, adapters, { evaluator });
    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.content).toBe("expensive");
  });

  test("returns cheap response when confidence is high", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.95 });

    const config = makeCascadeConfig([
      makeTarget("openai", "gpt-4o-mini"),
      makeTarget("openai", "gpt-4o"),
    ]);
    const adapters = new Map<string, ProviderAdapter>([
      [
        "openai",
        makeAdapter("openai", () => Promise.resolve(makeResponse("cheap ok", "gpt-4o-mini"))),
      ],
    ]);

    const router = createModelRouter(config, adapters, { evaluator });
    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.content).toBe("cheap ok");
  });

  test("routeStream with cascade uses fallback behavior", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.9 });
    const config = makeCascadeConfig([makeTarget("openai", "gpt-4o")]);
    const adapter = makeAdapter("openai", () => Promise.resolve(makeResponse("hi", "gpt-4o")));

    const router = createModelRouter(config, new Map([["openai", adapter]]), { evaluator });

    const chunks: StreamChunk[] = [];
    for await (const chunk of router.routeStream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.kind).toBe("text_delta");
  });

  test("cascade metrics include escalation counts", async () => {
    let evalCount = 0;
    const evaluator: CascadeEvaluator = () => {
      evalCount++;
      return { confidence: evalCount === 1 ? 0.2 : 0.9 };
    };

    const config = makeCascadeConfig([
      makeTarget("openai", "gpt-4o-mini"),
      makeTarget("anthropic", "claude"),
    ]);
    const adapters = new Map<string, ProviderAdapter>([
      [
        "openai",
        makeAdapter("openai", () => Promise.resolve(makeResponse("cheap", "gpt-4o-mini"))),
      ],
      [
        "anthropic",
        makeAdapter("anthropic", () => Promise.resolve(makeResponse("expensive", "claude"))),
      ],
    ]);

    const router = createModelRouter(config, adapters, { evaluator });
    await router.route(makeRequest());

    const metrics = router.getMetrics();
    expect(metrics.cascade).toBeDefined();
    expect(metrics.cascade?.totalEscalations).toBeGreaterThanOrEqual(1);
  });

  test("missing evaluator with cascade strategy throws", () => {
    const config = makeCascadeConfig([makeTarget("openai", "gpt-4o")]);
    const adapter = makeAdapter("openai", () => Promise.resolve(makeResponse("hi", "gpt-4o")));

    expect(() => createModelRouter(config, new Map([["openai", adapter]]))).toThrow(
      "Cascade strategy requires an evaluator",
    );
  });

  test("accepts legacy clock parameter (backwards compatibility)", async () => {
    const config = makeConfig([makeTarget("openai", "gpt-4o")]);
    const adapter = makeAdapter("openai", () => Promise.resolve(makeResponse("hi", "gpt-4o")));
    const customClock = () => 1000;

    const router = createModelRouter(config, new Map([["openai", adapter]]), customClock);
    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Pre-request classifier integration
  // -------------------------------------------------------------------------

  test("classifier skips cheap tier for complex request", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.9 });
    const cheapFn = mock((_req: ModelRequest) =>
      Promise.resolve(makeResponse("cheap answer", "gpt-4o-mini")),
    );
    const expensiveFn = mock((_req: ModelRequest) =>
      Promise.resolve(makeResponse("expensive answer", "gpt-4o")),
    );

    const classifier: CascadeClassifier = (_req, _tierCount) => ({
      score: 0.8,
      confidence: 0.95,
      tier: "HEAVY",
      recommendedTierIndex: 1,
      reason: "test: forced HEAVY",
    });

    const config = makeCascadeConfig([
      makeTarget("openai", "gpt-4o-mini"),
      makeTarget("openai", "gpt-4o"),
    ]);
    const adapters = new Map<string, ProviderAdapter>([
      [
        "openai",
        makeAdapter("openai", (req: ModelRequest) => {
          if (req.model === "gpt-4o-mini") return cheapFn(req);
          return expensiveFn(req);
        }),
      ],
    ]);

    const router = createModelRouter(config, adapters, { evaluator, classifier });
    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.content).toBe("expensive answer");
    expect(cheapFn).not.toHaveBeenCalled();
    expect(expensiveFn).toHaveBeenCalledTimes(1);
  });

  test("classifier returning index 0 uses all tiers normally", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.9 });
    const cheapFn = mock((_req: ModelRequest) =>
      Promise.resolve(makeResponse("cheap answer", "gpt-4o-mini")),
    );

    const classifier: CascadeClassifier = (_req, _tierCount) => ({
      score: 0.1,
      confidence: 0.95,
      tier: "LIGHT",
      recommendedTierIndex: 0,
      reason: "test: forced LIGHT",
    });

    const config = makeCascadeConfig([
      makeTarget("openai", "gpt-4o-mini"),
      makeTarget("openai", "gpt-4o"),
    ]);
    const adapters = new Map<string, ProviderAdapter>([
      ["openai", makeAdapter("openai", (req: ModelRequest) => cheapFn(req))],
    ]);

    const router = createModelRouter(config, adapters, { evaluator, classifier });
    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.content).toBe("cheap answer");
    expect(cheapFn).toHaveBeenCalledTimes(1);
  });

  test("cascade works without classifier (backwards compatible)", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.9 });
    const cheapFn = mock((_req: ModelRequest) =>
      Promise.resolve(makeResponse("cheap answer", "gpt-4o-mini")),
    );

    const config = makeCascadeConfig([
      makeTarget("openai", "gpt-4o-mini"),
      makeTarget("openai", "gpt-4o"),
    ]);
    const adapters = new Map<string, ProviderAdapter>([
      ["openai", makeAdapter("openai", (req: ModelRequest) => cheapFn(req))],
    ]);

    const router = createModelRouter(config, adapters, { evaluator });
    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.content).toBe("cheap answer");
  });

  test("classifier-based streaming selects correct starting tier", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.9 });
    const cheapStreamFn = mock(async function* (): AsyncGenerator<StreamChunk> {
      yield { kind: "text_delta", text: "cheap stream" };
      yield { kind: "finish", reason: "completed" };
    });
    const expensiveStreamFn = mock(async function* (): AsyncGenerator<StreamChunk> {
      yield { kind: "text_delta", text: "expensive stream" };
      yield { kind: "finish", reason: "completed" };
    });

    const classifier: CascadeClassifier = (_req, _tierCount) => ({
      score: 0.8,
      confidence: 0.95,
      tier: "HEAVY",
      recommendedTierIndex: 1,
      reason: "test: forced HEAVY",
    });

    const config = makeCascadeConfig([
      makeTarget("openai", "gpt-4o-mini"),
      makeTarget("openai", "gpt-4o"),
    ]);
    const adapters = new Map<string, ProviderAdapter>([
      [
        "openai",
        {
          id: "openai",
          complete: () => Promise.resolve(makeResponse("hi", "gpt-4o")),
          stream: (req: ModelRequest) =>
            req.model === "gpt-4o-mini" ? cheapStreamFn() : expensiveStreamFn(),
        },
      ],
    ]);

    const router = createModelRouter(config, adapters, { evaluator, classifier });

    const chunks: StreamChunk[] = [];
    for await (const chunk of router.routeStream(makeRequest())) {
      chunks.push(chunk);
    }

    const textChunk = chunks.find((c) => c.kind === "text_delta");
    if (textChunk?.kind === "text_delta") {
      expect(textChunk.text).toBe("expensive stream");
    }
    expect(cheapStreamFn).not.toHaveBeenCalled();
    expect(expensiveStreamFn).toHaveBeenCalledTimes(1);
  });

  test("classifier + evaluator together: classifier starts at MEDIUM, evaluator escalates", async () => {
    let evalCount = 0;
    const evaluator: CascadeEvaluator = () => {
      evalCount++;
      return { confidence: evalCount === 1 ? 0.2 : 0.9 };
    };

    const cheapFn = mock((_req: ModelRequest) =>
      Promise.resolve(makeResponse("cheap", "gpt-4o-mini")),
    );
    const mediumFn = mock((_req: ModelRequest) =>
      Promise.resolve(makeResponse("medium", "gpt-4o")),
    );
    const expensiveFn = mock((_req: ModelRequest) =>
      Promise.resolve(makeResponse("expensive", "claude")),
    );

    const classifier: CascadeClassifier = (_req, _tierCount) => ({
      score: 0.5,
      confidence: 0.85,
      tier: "MEDIUM",
      recommendedTierIndex: 1,
      reason: "test: forced MEDIUM",
    });

    const config = makeCascadeConfig([
      makeTarget("openai", "gpt-4o-mini"),
      makeTarget("openai", "gpt-4o"),
      makeTarget("anthropic", "claude"),
    ]);
    const adapters = new Map<string, ProviderAdapter>([
      [
        "openai",
        makeAdapter("openai", (req: ModelRequest) => {
          if (req.model === "gpt-4o-mini") return cheapFn(req);
          return mediumFn(req);
        }),
      ],
      ["anthropic", makeAdapter("anthropic", (req: ModelRequest) => expensiveFn(req))],
    ]);

    const router = createModelRouter(config, adapters, { evaluator, classifier });
    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(cheapFn).not.toHaveBeenCalled();
    expect(mediumFn).toHaveBeenCalledTimes(1);
    expect(expensiveFn).toHaveBeenCalledTimes(1);
    expect(result.value.content).toBe("expensive");
  });
});
