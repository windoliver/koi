/**
 * E2E test for the pre-request complexity classifier + cascade router.
 *
 * Validates the full pipeline with real LLM calls:
 *   Classifier → tier slicing → withCascade → real model response
 *
 * Uses a 2-tier cascade (both OpenAI to avoid cross-provider issues):
 *   Tier 0 (LIGHT):  OpenAI gpt-4o-mini  (cheap)
 *   Tier 1 (HEAVY):  OpenAI gpt-4o       (more capable)
 *
 * Gated on OPENAI_API_KEY.
 *
 * Run:
 *   OPENAI_API_KEY=... bun test src/__tests__/cascade-classifier-e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@koi/core";
import { createOpenAIAdapter } from "../adapters/openai.js";
import type { CascadeEvaluator } from "../cascade/cascade-types.js";
import { createComplexityClassifier } from "../cascade/complexity-classifier.js";
import { createKeywordEvaluator } from "../cascade/evaluators.js";
import type { ResolvedRouterConfig } from "../config.js";
import type { ProviderAdapter } from "../provider-adapter.js";
import { createModelRouter } from "../router.js";

// ---------------------------------------------------------------------------
// Env gate
// ---------------------------------------------------------------------------

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const HAS_KEYS = OPENAI_KEY.length > 0;
// E2E tests require API key AND explicit opt-in via E2E_TESTS=1 to avoid
// rate-limit failures when 500+ test files run in parallel.
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEYS && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(text: string, maxTokens = 30): ModelRequest {
  return {
    messages: [
      {
        content: [{ kind: "text" as const, text }],
        senderId: "e2e-user",
        timestamp: Date.now(),
      },
    ],
    maxTokens,
    temperature: 0,
  };
}

// ---------------------------------------------------------------------------
// Shared setup: 2-tier OpenAI cascade (gpt-4o-mini → gpt-4o)
// ---------------------------------------------------------------------------

function createCascadeRouter(evaluator: CascadeEvaluator): {
  readonly router: ReturnType<typeof createModelRouter>;
  readonly config: ResolvedRouterConfig;
} {
  const classifier = createComplexityClassifier();

  const config: ResolvedRouterConfig = {
    targets: [
      {
        provider: "openai-cheap",
        model: "gpt-4o-mini",
        weight: 1,
        enabled: true,
        adapterConfig: { apiKey: OPENAI_KEY },
      },
      {
        provider: "openai-expensive",
        model: "gpt-4o",
        weight: 1,
        enabled: true,
        adapterConfig: { apiKey: OPENAI_KEY },
      },
    ],
    strategy: "cascade",
    retry: {
      maxRetries: 1,
      backoffMultiplier: 2,
      initialDelayMs: 100,
      maxBackoffMs: 1000,
      jitter: false,
    },
    circuitBreaker: {
      failureThreshold: 3,
      cooldownMs: 60_000,
      failureWindowMs: 60_000,
      failureStatusCodes: [429, 500, 502, 503, 504],
    },
    cascade: {
      tiers: [{ targetId: "openai-cheap:gpt-4o-mini" }, { targetId: "openai-expensive:gpt-4o" }],
      confidenceThreshold: 0.7,
      maxEscalations: 1,
      budgetLimitTokens: 0,
      evaluatorTimeoutMs: 10_000,
    },
  };

  const adapters = new Map<string, ProviderAdapter>([
    ["openai-cheap", createOpenAIAdapter({ apiKey: OPENAI_KEY })],
    ["openai-expensive", createOpenAIAdapter({ apiKey: OPENAI_KEY })],
  ]);

  const router = createModelRouter(config, adapters, {
    evaluator,
    classifier,
  });

  return { router, config };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: cascade with complexity classifier", () => {
  // -------------------------------------------------------------------------
  // Test 1: Simple prompt → classifier routes to LIGHT → cheap model
  // -------------------------------------------------------------------------

  test(
    "simple prompt classified LIGHT → cheap tier responds successfully",
    async () => {
      const evaluator: CascadeEvaluator = () => ({ confidence: 0.95 });
      const { router } = createCascadeRouter(evaluator);

      const classifier = createComplexityClassifier();
      const classification = classifier(makeRequest("Reply with one word: hello"), 2);

      console.log("[LIGHT test] classification:", {
        score: classification.score.toFixed(3),
        confidence: classification.confidence.toFixed(3),
        tier: classification.tier,
        index: classification.recommendedTierIndex,
      });

      expect(classification.tier).toBe("LIGHT");
      expect(classification.recommendedTierIndex).toBe(0);

      const result = await router.route(makeRequest("Reply with one word: hello"));

      if (!result.ok) {
        console.error("[LIGHT test] route error:", result.error);
      }
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`Route failed: ${result.error.message}`);

      console.log("[LIGHT test] response:", {
        content: result.value.content.slice(0, 100),
        model: result.value.model,
      });

      expect(result.value.content.length).toBeGreaterThan(0);

      // Metrics: cheap tier should have been called
      const metrics = router.getMetrics();
      expect(metrics.totalRequests).toBe(1);
      expect(metrics.requestsByTarget["openai-cheap:gpt-4o-mini"] ?? 0).toBeGreaterThanOrEqual(1);

      router.dispose();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 2: Complex prompt → classifier routes to HEAVY → skips cheap
  // -------------------------------------------------------------------------

  test(
    "complex prompt classified HEAVY → skips cheap tier, routes to expensive",
    async () => {
      const evaluator: CascadeEvaluator = () => ({ confidence: 0.95 });
      const { router } = createCascadeRouter(evaluator);

      const complexPrompt =
        "Analyze and evaluate the trade-offs of distributed consensus algorithms. " +
        "Compare Raft vs Paxos and prove which is more suitable for a microservices architecture.";

      const classifier = createComplexityClassifier();
      const classification = classifier(makeRequest(complexPrompt), 2);

      console.log("[HEAVY test] classification:", {
        score: classification.score.toFixed(3),
        confidence: classification.confidence.toFixed(3),
        tier: classification.tier,
        index: classification.recommendedTierIndex,
      });

      expect(classification.tier).toBe("HEAVY");
      expect(classification.recommendedTierIndex).toBe(1);

      const result = await router.route(makeRequest(complexPrompt, 100));

      if (!result.ok) {
        console.error("[HEAVY test] route error:", result.error);
      }
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`Route failed: ${result.error.message}`);

      console.log("[HEAVY test] response:", {
        content: `${result.value.content.slice(0, 100)}...`,
        model: result.value.model,
      });

      expect(result.value.content.length).toBeGreaterThan(0);

      // Metrics: cheap tier should NOT have been called — classifier skipped it
      const metrics = router.getMetrics();
      expect(metrics.requestsByTarget["openai-cheap:gpt-4o-mini"] ?? 0).toBe(0);
      expect(metrics.requestsByTarget["openai-expensive:gpt-4o"] ?? 0).toBeGreaterThanOrEqual(1);

      router.dispose();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 3: Classifier + evaluator — LIGHT start, evaluator escalates
  // -------------------------------------------------------------------------

  test(
    "classifier + evaluator: LIGHT tier with evaluator escalation",
    async () => {
      // Evaluator rejects cheap model, accepts expensive
      const evaluator: CascadeEvaluator = (_req, response) => {
        if (response.model?.includes("gpt-4o-mini")) {
          return { confidence: 0.2, reason: "Cheap model insufficient" };
        }
        return { confidence: 0.95, reason: "Expensive model adequate" };
      };
      const { router } = createCascadeRouter(evaluator);

      const result = await router.route(makeRequest("What is the capital of France?"));

      if (!result.ok) {
        console.error("[ESCALATION test] route error:", result.error);
      }
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`Route failed: ${result.error.message}`);

      console.log("[ESCALATION test] response:", {
        content: result.value.content.slice(0, 100),
        model: result.value.model,
      });

      expect(result.value.content.length).toBeGreaterThan(0);

      // Both tiers should have been called (cheap tried, then escalated)
      const metrics = router.getMetrics();
      expect(metrics.requestsByTarget["openai-cheap:gpt-4o-mini"] ?? 0).toBeGreaterThanOrEqual(1);
      expect(metrics.requestsByTarget["openai-expensive:gpt-4o"] ?? 0).toBeGreaterThanOrEqual(1);
      expect(metrics.cascade?.totalEscalations).toBeGreaterThanOrEqual(1);

      router.dispose();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 4: Classifier confidence — verify sigmoid values for varied prompts
  // -------------------------------------------------------------------------

  test("classifier produces valid confidence values for varied prompts", () => {
    const classifier = createComplexityClassifier();

    const prompts = [
      { text: "hello", expectedTier: "LIGHT" as const },
      { text: "what is 2+2?", expectedTier: "LIGHT" as const },
      { text: "thanks", expectedTier: "LIGHT" as const },
      {
        text: "first check the database schema, then deploy the api pipeline as json",
        expectedTier: "MEDIUM" as const,
      },
      {
        text: "analyze and evaluate this distributed consensus algorithm with formal proof",
        expectedTier: "HEAVY" as const,
      },
      {
        text: "forward this to the team and check status",
        expectedTier: "LIGHT" as const,
      },
    ];

    console.log("\n[CONFIDENCE test] Classification results:");
    console.log("─".repeat(90));
    console.log(
      `${"Prompt".padEnd(55) + "Score".padEnd(8) + "Conf".padEnd(8) + "Tier".padEnd(8)}Expected`,
    );
    console.log("─".repeat(90));

    for (const { text, expectedTier } of prompts) {
      const result = classifier(makeRequest(text), 3);

      const displayText = text.length > 52 ? `${text.slice(0, 49)}...` : text;
      console.log(
        displayText.padEnd(55) +
          result.score.toFixed(3).padEnd(8) +
          result.confidence.toFixed(3).padEnd(8) +
          result.tier.padEnd(8) +
          expectedTier,
      );

      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.tier).toBe(expectedTier);
      expect(result.dimensions).toBeDefined();
    }

    console.log("─".repeat(90));
  });

  // -------------------------------------------------------------------------
  // Test 5: Keyword evaluator + classifier (realistic production combo)
  // -------------------------------------------------------------------------

  test(
    "realistic setup: keyword evaluator + classifier with real calls",
    async () => {
      const evaluator = createKeywordEvaluator();
      const { router } = createCascadeRouter(evaluator);

      // Simple prompt — should use cheap tier and get accepted
      const simpleResult = await router.route(makeRequest("Reply with exactly one word: hello"));

      if (!simpleResult.ok) {
        console.error("[KEYWORD E2E] simple error:", simpleResult.error);
      }
      expect(simpleResult.ok).toBe(true);
      if (!simpleResult.ok) throw new Error("Simple route failed");

      console.log("[KEYWORD E2E] simple:", {
        content: simpleResult.value.content.slice(0, 50),
        model: simpleResult.value.model,
      });

      expect(simpleResult.value.content.length).toBeGreaterThan(0);

      // Complex prompt — classifier should skip to expensive tier
      const complexResult = await router.route(
        makeRequest(
          "Analyze the trade-offs between Raft and Paxos consensus algorithms and evaluate their suitability",
          100,
        ),
      );

      if (!complexResult.ok) {
        console.error("[KEYWORD E2E] complex error:", complexResult.error);
      }
      expect(complexResult.ok).toBe(true);
      if (!complexResult.ok) throw new Error("Complex route failed");

      console.log("[KEYWORD E2E] complex:", {
        content: `${complexResult.value.content.slice(0, 100)}...`,
        model: complexResult.value.model,
      });

      expect(complexResult.value.content.length).toBeGreaterThan(0);

      const metrics = router.getMetrics();
      console.log("[KEYWORD E2E] metrics:", {
        totalRequests: metrics.totalRequests,
        requestsByTarget: metrics.requestsByTarget,
        escalations: metrics.cascade?.totalEscalations,
      });

      router.dispose();
    },
    TIMEOUT_MS,
  );
});
