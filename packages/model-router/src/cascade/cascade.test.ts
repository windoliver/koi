import { describe, expect, mock, test } from "bun:test";
import type { ModelRequest, ModelResponse } from "@koi/core";
import type { CircuitBreaker, CircuitBreakerSnapshot } from "../circuit-breaker.js";
import { withCascade } from "./cascade.js";
import type {
  CascadeEvaluator,
  CascadeTierConfig,
  ResolvedCascadeConfig,
} from "./cascade-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(text = "test"): ModelRequest {
  return {
    messages: [{ content: [{ kind: "text" as const, text }], senderId: "test-user", timestamp: 0 }],
  };
}

function makeResponse(
  content: string,
  opts?: {
    inputTokens?: number;
    outputTokens?: number;
  },
): ModelResponse {
  return {
    content,
    model: "test-model",
    ...(opts
      ? { usage: { inputTokens: opts.inputTokens ?? 0, outputTokens: opts.outputTokens ?? 0 } }
      : {}),
  };
}

function makeTiers(...ids: readonly string[]): readonly CascadeTierConfig[] {
  return ids.map((id) => ({ targetId: id }));
}

function makeConfig(overrides?: Partial<ResolvedCascadeConfig>): ResolvedCascadeConfig {
  return {
    tiers: makeTiers("cheap:model", "medium:model", "expensive:model"),
    confidenceThreshold: 0.7,
    maxEscalations: 2,
    budgetLimitTokens: 0,
    evaluatorTimeoutMs: 5_000,
    ...overrides,
  };
}

function makeOpenCircuitBreaker(): CircuitBreaker {
  return {
    isAllowed: () => false,
    recordSuccess: () =>
      ({
        state: "OPEN",
        failureCount: 0,
        lastFailureAt: undefined,
        lastTransitionAt: 0,
      }) satisfies CircuitBreakerSnapshot,
    recordFailure: () =>
      ({
        state: "OPEN",
        failureCount: 1,
        lastFailureAt: 0,
        lastTransitionAt: 0,
      }) satisfies CircuitBreakerSnapshot,
    getSnapshot: () =>
      ({
        state: "OPEN",
        failureCount: 0,
        lastFailureAt: undefined,
        lastTransitionAt: 0,
      }) satisfies CircuitBreakerSnapshot,
    reset: () => {},
  };
}

function makeClosedCircuitBreaker(): CircuitBreaker {
  return {
    isAllowed: () => true,
    recordSuccess: () =>
      ({
        state: "CLOSED",
        failureCount: 0,
        lastFailureAt: undefined,
        lastTransitionAt: 0,
      }) satisfies CircuitBreakerSnapshot,
    recordFailure: () =>
      ({
        state: "CLOSED",
        failureCount: 1,
        lastFailureAt: 0,
        lastTransitionAt: 0,
      }) satisfies CircuitBreakerSnapshot,
    getSnapshot: () =>
      ({
        state: "CLOSED",
        failureCount: 0,
        lastFailureAt: undefined,
        lastTransitionAt: 0,
      }) satisfies CircuitBreakerSnapshot,
    reset: () => {},
  };
}

const noCBs = new Map<string, CircuitBreaker>();

// ---------------------------------------------------------------------------
// withCascade
// ---------------------------------------------------------------------------

describe("withCascade", () => {
  test("cheap model accepted when confidence >= threshold", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.9 });
    const fn = mock((tier: CascadeTierConfig) =>
      Promise.resolve(makeResponse(`response from ${tier.targetId}`)),
    );

    const result = await withCascade(
      makeTiers("cheap:model", "expensive:model"),
      fn,
      evaluator,
      makeConfig({ tiers: makeTiers("cheap:model", "expensive:model"), maxEscalations: 1 }),
      noCBs,
      makeRequest(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.tierId).toBe("cheap:model");
    expect(result.value.confidence).toBe(0.9);
    expect(result.value.totalEscalations).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("escalates from cheap to medium when confidence is low", async () => {
    let callCount = 0;
    const evaluator: CascadeEvaluator = () => {
      callCount++;
      // First call (cheap) → low confidence, second call won't happen (last tier)
      return { confidence: callCount === 1 ? 0.3 : 0.9 };
    };

    const fn = mock((tier: CascadeTierConfig) =>
      Promise.resolve(makeResponse(`response from ${tier.targetId}`)),
    );

    const result = await withCascade(
      makeTiers("cheap:model", "medium:model", "expensive:model"),
      fn,
      evaluator,
      makeConfig(),
      noCBs,
      makeRequest(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    // Second tier (medium) evaluated and accepted
    expect(result.value.tierId).toBe("medium:model");
    expect(result.value.totalEscalations).toBe(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("returns last tier response without evaluation", async () => {
    const evaluator: CascadeEvaluator = mock(() => ({ confidence: 0.1 }));

    const fn = mock((tier: CascadeTierConfig) =>
      Promise.resolve(makeResponse(`from ${tier.targetId}`)),
    );

    const result = await withCascade(
      makeTiers("cheap:model", "expensive:model"),
      fn,
      evaluator,
      makeConfig({ tiers: makeTiers("cheap:model", "expensive:model"), maxEscalations: 1 }),
      noCBs,
      makeRequest(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    // Last tier is accepted with confidence 1 (no evaluation)
    expect(result.value.tierId).toBe("expensive:model");
    expect(result.value.confidence).toBe(1);
  });

  test("provider error on cheap tier skips to next", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.9 });
    const fn = mock((tier: CascadeTierConfig) => {
      if (tier.targetId === "cheap:model") {
        return Promise.reject(new Error("provider down"));
      }
      return Promise.resolve(makeResponse("from medium"));
    });

    const result = await withCascade(
      makeTiers("cheap:model", "medium:model"),
      fn,
      evaluator,
      makeConfig({ tiers: makeTiers("cheap:model", "medium:model"), maxEscalations: 1 }),
      noCBs,
      makeRequest(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    // Medium is last tier, accepted without evaluation
    expect(result.value.tierId).toBe("medium:model");
    expect(result.value.attempts[0]?.success).toBe(false);
    expect(result.value.attempts[0]?.error).toContain("provider down");
  });

  test("all tiers fail with errors returns error result", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.9 });
    const fn = mock(() => Promise.reject(new Error("all down")));

    const result = await withCascade(
      makeTiers("cheap:model", "expensive:model"),
      fn,
      evaluator,
      makeConfig({ tiers: makeTiers("cheap:model", "expensive:model"), maxEscalations: 1 }),
      noCBs,
      makeRequest(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("EXTERNAL");
    expect(result.error.message).toContain("All");
    expect(result.error.message).toContain("cascade tiers failed");
  });

  test("circuit breaker open on cheap tier skips to next", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.9 });
    const fn = mock((tier: CascadeTierConfig) =>
      Promise.resolve(makeResponse(`from ${tier.targetId}`)),
    );

    const cbs = new Map<string, CircuitBreaker>([
      ["cheap:model", makeOpenCircuitBreaker()],
      ["expensive:model", makeClosedCircuitBreaker()],
    ]);

    const result = await withCascade(
      makeTiers("cheap:model", "expensive:model"),
      fn,
      evaluator,
      makeConfig({ tiers: makeTiers("cheap:model", "expensive:model"), maxEscalations: 1 }),
      cbs,
      makeRequest(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.tierId).toBe("expensive:model");
    // Only called once (expensive), cheap was skipped
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("evaluator throws treats as confidence 0.0 (fail-open)", async () => {
    const evaluator: CascadeEvaluator = () => {
      throw new Error("evaluator broke");
    };
    const fn = mock((tier: CascadeTierConfig) =>
      Promise.resolve(makeResponse(`from ${tier.targetId}`)),
    );

    const result = await withCascade(
      makeTiers("cheap:model", "expensive:model"),
      fn,
      evaluator,
      makeConfig({ tiers: makeTiers("cheap:model", "expensive:model"), maxEscalations: 1 }),
      noCBs,
      makeRequest(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    // Cheap evaluator failed → confidence 0 → escalated to expensive (last tier, accepted)
    expect(result.value.tierId).toBe("expensive:model");
    expect(result.value.totalEscalations).toBe(1);
  });

  test("budget exhausted returns best response so far", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.3 });
    const fn = mock(() =>
      Promise.resolve(makeResponse("response", { inputTokens: 5000, outputTokens: 5000 })),
    );

    const config = makeConfig({
      tiers: makeTiers("cheap:model", "expensive:model"),
      maxEscalations: 1,
      budgetLimitTokens: 5000,
    });

    const result = await withCascade(
      makeTiers("cheap:model", "expensive:model"),
      fn,
      evaluator,
      config,
      noCBs,
      makeRequest(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    // Budget exceeded after first tier, return what we have
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("single tier returns immediately without evaluation", async () => {
    const evaluator: CascadeEvaluator = mock(() => ({ confidence: 0.1 }));
    const fn = mock(() => Promise.resolve(makeResponse("only response")));

    const result = await withCascade(
      makeTiers("only:model"),
      fn,
      evaluator,
      makeConfig({ tiers: makeTiers("only:model"), maxEscalations: 0 }),
      noCBs,
      makeRequest(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.tierId).toBe("only:model");
    expect(result.value.confidence).toBe(1);
    // Evaluator should NOT have been called (single/last tier)
    expect(evaluator).not.toHaveBeenCalled();
  });

  test("max escalations limit returns best response below threshold", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 0.3 });
    const fn = mock((tier: CascadeTierConfig) =>
      Promise.resolve(makeResponse(`from ${tier.targetId}`)),
    );

    const config = makeConfig({
      tiers: makeTiers("cheap:model", "medium:model", "expensive:model"),
      maxEscalations: 1,
      confidenceThreshold: 0.9,
    });

    const result = await withCascade(
      makeTiers("cheap:model", "medium:model", "expensive:model"),
      fn,
      evaluator,
      config,
      noCBs,
      makeRequest(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    // After cheap (escalate) → medium (max escalations hit, return best)
    expect(result.value.totalEscalations).toBe(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("empty tiers returns validation error", async () => {
    const evaluator: CascadeEvaluator = () => ({ confidence: 1 });
    const fn = mock(() => Promise.resolve(makeResponse("test")));

    const result = await withCascade(
      [],
      fn,
      evaluator,
      makeConfig({ tiers: [] }),
      noCBs,
      makeRequest(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
  });

  test("attempts array records all tiers visited", async () => {
    let evalCount = 0;
    const evaluator: CascadeEvaluator = () => {
      evalCount++;
      return { confidence: evalCount === 1 ? 0.2 : 0.9 };
    };

    const fn = mock(() => Promise.resolve(makeResponse("resp")));

    const result = await withCascade(
      makeTiers("tier1", "tier2", "tier3"),
      fn,
      evaluator,
      makeConfig({ tiers: makeTiers("tier1", "tier2", "tier3") }),
      noCBs,
      makeRequest(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.attempts).toHaveLength(2);
    expect(result.value.attempts[0]?.tierId).toBe("tier1");
    expect(result.value.attempts[0]?.escalated).toBe(true);
    expect(result.value.attempts[1]?.tierId).toBe("tier2");
    expect(result.value.attempts[1]?.escalated).toBe(false);
  });
});
