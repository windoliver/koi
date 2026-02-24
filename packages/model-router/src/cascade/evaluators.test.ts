import { describe, expect, mock, test } from "bun:test";
import type { ModelRequest, ModelResponse } from "@koi/core";
import type { ProviderAdapter } from "../provider-adapter.js";
import type { CascadeEvaluator } from "./cascade-types.js";
import {
  composeEvaluators,
  createKeywordEvaluator,
  createLengthHeuristicEvaluator,
  createVerbalizedEvaluator,
} from "./evaluators.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(): ModelRequest {
  return {
    messages: [
      { content: [{ kind: "text" as const, text: "test" }], senderId: "user", timestamp: 0 },
    ],
  };
}

function makeResponse(content: string): ModelResponse {
  return { content, model: "test-model" };
}

// ---------------------------------------------------------------------------
// createLengthHeuristicEvaluator
// ---------------------------------------------------------------------------

describe("createLengthHeuristicEvaluator", () => {
  const evaluator = createLengthHeuristicEvaluator();

  test("empty response returns confidence 0", async () => {
    const result = await evaluator(makeRequest(), makeResponse(""));
    expect(result).toEqual(expect.objectContaining({ confidence: 0 }));
  });

  test("whitespace-only response returns confidence 0", async () => {
    const result = await evaluator(makeRequest(), makeResponse("   "));
    expect(result).toEqual(expect.objectContaining({ confidence: 0 }));
  });

  test("response below minLength returns confidence 0", async () => {
    const result = await evaluator(makeRequest(), makeResponse("short"));
    expect(result).toEqual(expect.objectContaining({ confidence: 0 }));
  });

  test("response at target length returns confidence 1", async () => {
    const content = "a".repeat(200);
    const result = await evaluator(makeRequest(), makeResponse(content));
    expect(result).toEqual(expect.objectContaining({ confidence: 1 }));
  });

  test("response above target length returns confidence 1", async () => {
    const content = "a".repeat(500);
    const result = await evaluator(makeRequest(), makeResponse(content));
    expect(result).toEqual(expect.objectContaining({ confidence: 1 }));
  });

  test("response between min and target returns interpolated confidence", async () => {
    // Default min=10, target=200. Length 105 → (105-10)/(200-10) = 95/190 = 0.5
    const content = "a".repeat(105);
    const result = await evaluator(makeRequest(), makeResponse(content));
    expect(result.confidence).toBeCloseTo(0.5, 1);
  });

  test("response at exact minLength boundary returns confidence 0", async () => {
    // Length exactly 10 → (10-10)/(200-10) = 0
    const content = "a".repeat(10);
    const result = await evaluator(makeRequest(), makeResponse(content));
    expect(result.confidence).toBeCloseTo(0, 5);
  });

  test("custom options override defaults", async () => {
    const custom = createLengthHeuristicEvaluator({ minLength: 5, targetLength: 50 });
    // Length 27.5 → midpoint → but we need integer
    const content = "a".repeat(28);
    const result = await custom(makeRequest(), makeResponse(content));
    // (28-5)/(50-5) = 23/45 ≈ 0.511
    expect(result.confidence).toBeGreaterThan(0.4);
    expect(result.confidence).toBeLessThan(0.6);
  });
});

// ---------------------------------------------------------------------------
// createKeywordEvaluator
// ---------------------------------------------------------------------------

describe("createKeywordEvaluator", () => {
  const evaluator = createKeywordEvaluator();

  test("no markers found returns confidence 1", async () => {
    const result = await evaluator(makeRequest(), makeResponse("The answer is 42."));
    expect(result.confidence).toBe(1);
  });

  test("one marker found reduces confidence by penalty", async () => {
    const result = await evaluator(makeRequest(), makeResponse("I'm not sure, but maybe 42."));
    expect(result.confidence).toBe(0.8);
  });

  test("multiple markers reduce confidence cumulatively", async () => {
    const result = await evaluator(
      makeRequest(),
      makeResponse("I'm not sure and I don't know. It depends on context."),
    );
    // 3 markers × 0.2 = 0.6 penalty → confidence 0.4
    expect(result.confidence).toBeCloseTo(0.4, 5);
  });

  test("confidence is clamped to 0 floor", async () => {
    const result = await evaluator(
      makeRequest(),
      makeResponse(
        "I'm not sure, I don't know, it depends, I cannot, I can't, as an AI language model.",
      ),
    );
    expect(result.confidence).toBe(0);
  });

  test("case insensitive matching", async () => {
    const result = await evaluator(makeRequest(), makeResponse("I'M NOT SURE about that."));
    expect(result.confidence).toBe(0.8);
  });

  test("empty response returns confidence 1", async () => {
    const result = await evaluator(makeRequest(), makeResponse(""));
    expect(result.confidence).toBe(1);
  });

  test("custom markers and penalty", async () => {
    const custom = createKeywordEvaluator({
      uncertaintyMarkers: ["maybe", "perhaps"],
      penaltyPerMarker: 0.5,
    });
    const result = await custom(makeRequest(), makeResponse("maybe perhaps"));
    expect(result.confidence).toBe(0);
  });

  test("returns matched markers in metadata", async () => {
    const result = await evaluator(makeRequest(), makeResponse("I apologize for the confusion."));
    expect(result.metadata).toBeDefined();
    const metadata = result.metadata as Record<string, unknown>;
    expect(metadata.matchCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createVerbalizedEvaluator
// ---------------------------------------------------------------------------

describe("createVerbalizedEvaluator", () => {
  function makeAdapter(response: string): ProviderAdapter {
    return {
      id: "test",
      complete: mock(() => Promise.resolve({ content: response, model: "test" })),
      async *stream() {
        yield { kind: "finish" as const, reason: "completed" };
      },
    };
  }

  test("parses numeric confidence response", async () => {
    const adapter = makeAdapter("0.73");
    const evaluator = createVerbalizedEvaluator(adapter);
    const result = await evaluator(makeRequest(), makeResponse("Hello world"));
    expect(result.confidence).toBeCloseTo(0.73, 5);
  });

  test("non-numeric response returns 0.5", async () => {
    const adapter = makeAdapter("high confidence");
    const evaluator = createVerbalizedEvaluator(adapter);
    const result = await evaluator(makeRequest(), makeResponse("Hello world"));
    expect(result.confidence).toBe(0.5);
  });

  test("empty response returns 0.5", async () => {
    const adapter = makeAdapter("");
    const evaluator = createVerbalizedEvaluator(adapter);
    const result = await evaluator(makeRequest(), makeResponse("Hello world"));
    expect(result.confidence).toBe(0.5);
  });

  test("response > 1 returns 0.5", async () => {
    const adapter = makeAdapter("2.5");
    const evaluator = createVerbalizedEvaluator(adapter);
    const result = await evaluator(makeRequest(), makeResponse("Hello world"));
    expect(result.confidence).toBe(0.5);
  });

  test("response < 0 returns 0.5", async () => {
    const adapter = makeAdapter("-0.3");
    const evaluator = createVerbalizedEvaluator(adapter);
    const result = await evaluator(makeRequest(), makeResponse("Hello world"));
    expect(result.confidence).toBe(0.5);
  });

  test("calls adapter with correct messages", async () => {
    const adapter = makeAdapter("0.9");
    const completeFn = adapter.complete as ReturnType<typeof mock>;
    const evaluator = createVerbalizedEvaluator(adapter);

    await evaluator(makeRequest(), makeResponse("My answer is 42"));

    expect(completeFn).toHaveBeenCalledTimes(1);
    const callArgs = completeFn.mock.calls[0]?.[0] as ModelRequest;
    expect(callArgs.messages.length).toBeGreaterThan(1);
  });

  test("adapter error propagates", async () => {
    const adapter: ProviderAdapter = {
      id: "test",
      complete: () => Promise.reject(new Error("adapter failed")),
      async *stream() {
        yield { kind: "finish" as const, reason: "completed" };
      },
    };
    const evaluator = createVerbalizedEvaluator(adapter);

    await expect(evaluator(makeRequest(), makeResponse("test"))).rejects.toThrow("adapter failed");
  });
});

// ---------------------------------------------------------------------------
// composeEvaluators
// ---------------------------------------------------------------------------

describe("composeEvaluators", () => {
  const highConfidence: CascadeEvaluator = () => ({ confidence: 0.9, reason: "high" });
  const lowConfidence: CascadeEvaluator = () => ({ confidence: 0.3, reason: "low" });

  test("min strategy returns minimum confidence", async () => {
    const composed = composeEvaluators([highConfidence, lowConfidence], "min");
    const result = await composed(makeRequest(), makeResponse("test"));
    expect(result.confidence).toBe(0.3);
  });

  test("average strategy returns mean confidence", async () => {
    const composed = composeEvaluators([highConfidence, lowConfidence], "average");
    const result = await composed(makeRequest(), makeResponse("test"));
    expect(result.confidence).toBeCloseTo(0.6, 5);
  });

  test("weighted strategy uses provided weights", async () => {
    const composed = composeEvaluators(
      [
        { evaluator: highConfidence, weight: 3 },
        { evaluator: lowConfidence, weight: 1 },
      ],
      "weighted",
    );
    const result = await composed(makeRequest(), makeResponse("test"));
    // (0.9*3 + 0.3*1) / 4 = 3.0 / 4 = 0.75
    expect(result.confidence).toBeCloseTo(0.75, 5);
  });

  test("default strategy is min", async () => {
    const composed = composeEvaluators([highConfidence, lowConfidence]);
    const result = await composed(makeRequest(), makeResponse("test"));
    expect(result.confidence).toBe(0.3);
  });

  test("skips failing evaluator and uses remaining", async () => {
    const failing: CascadeEvaluator = () => {
      throw new Error("evaluator broke");
    };
    const composed = composeEvaluators([failing, highConfidence], "min");
    const result = await composed(makeRequest(), makeResponse("test"));
    expect(result.confidence).toBe(0.9);
  });

  test("all evaluators failing returns confidence 0", async () => {
    const failing: CascadeEvaluator = () => {
      throw new Error("broke");
    };
    const composed = composeEvaluators([failing], "min");
    const result = await composed(makeRequest(), makeResponse("test"));
    expect(result.confidence).toBe(0);
    expect(result.reason).toContain("All evaluators failed");
  });

  test("empty evaluators array returns confidence 0", async () => {
    const composed = composeEvaluators([], "min");
    const result = await composed(makeRequest(), makeResponse("test"));
    expect(result.confidence).toBe(0);
  });
});
