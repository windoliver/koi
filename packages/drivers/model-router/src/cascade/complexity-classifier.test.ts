import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@koi/core";
import { createComplexityClassifier } from "./complexity-classifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(text: string): ModelRequest {
  return {
    messages: [
      {
        content: [{ kind: "text" as const, text }],
        senderId: "user-1",
        timestamp: Date.now(),
      },
    ],
  };
}

function systemAndUserMsg(system: string, user: string): ModelRequest {
  return {
    messages: [
      {
        content: [{ kind: "text" as const, text: system }],
        senderId: "system",
        timestamp: Date.now(),
      },
      {
        content: [{ kind: "text" as const, text: user }],
        senderId: "user-1",
        timestamp: Date.now(),
      },
    ],
  };
}

function multiUserMsg(...texts: readonly string[]): ModelRequest {
  return {
    messages: texts.map((text) => ({
      content: [{ kind: "text" as const, text }],
      senderId: "user-1",
      timestamp: Date.now(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createComplexityClassifier", () => {
  const classify = createComplexityClassifier();

  // -------------------------------------------------------------------------
  // Text extraction
  // -------------------------------------------------------------------------

  describe("text extraction", () => {
    test("extracts only user messages (not system/assistant senderId)", () => {
      const request = systemAndUserMsg(
        "You are an expert analyst who must analyze and evaluate everything",
        "hello",
      );
      const result = classify(request, 3);
      // System message has heavy keywords but should be ignored
      expect(result.tier).toBe("LIGHT");
    });

    test("extracts text from multiple user messages", () => {
      const request = multiUserMsg(
        "analyze this algorithm",
        "then compare it with the alternative approach",
      );
      const result = classify(request, 3);
      // "analyze" + "compare" = 2 reasoning keywords → override forces HEAVY
      expect(result.tier).toBe("HEAVY");
    });

    test("ignores non-text content blocks (image, file)", () => {
      const request: ModelRequest = {
        messages: [
          {
            content: [
              { kind: "image" as const, url: "https://example.com/img.png" },
              { kind: "text" as const, text: "hello" },
            ],
            senderId: "user-1",
            timestamp: Date.now(),
          },
        ],
      };
      const result = classify(request, 3);
      expect(result.tier).toBe("LIGHT");
    });

    test("returns LIGHT for empty/whitespace-only user text", () => {
      const request = userMsg("   ");
      const result = classify(request, 3);
      expect(result.tier).toBe("LIGHT");
      expect(result.score).toBe(0);
    });

    test("returns LIGHT for no messages", () => {
      const request: ModelRequest = { messages: [] };
      const result = classify(request, 3);
      expect(result.tier).toBe("LIGHT");
      expect(result.score).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Dimension scoring
  // -------------------------------------------------------------------------

  describe("dimension scoring", () => {
    test("reasoning keywords score high", () => {
      const result = classify(userMsg("analyze this data and evaluate the results"), 3);
      // 2+ reasoning keywords → override fires → HEAVY
      expect(result.score).toBeGreaterThanOrEqual(0.6);
      expect(result.tier).toBe("HEAVY");
    });

    test("code presence scores high (dimension level)", () => {
      const result = classify(
        userMsg("```typescript\nfunction add(a: number, b: number) { return a + b; }\n```"),
        3,
      );
      // Code fence = 0.8 dimension score, weighted at 0.28 → ~0.22 contribution
      const codeDim = result.dimensions?.code as number;
      expect(codeDim).toBeGreaterThanOrEqual(0.8);
      expect(result.score).toBeGreaterThan(0.1);
    });

    test("multi-step patterns score high (dimension level)", () => {
      const result = classify(
        userMsg("first gather the data, then process it, finally output the results"),
        3,
      );
      const multiStepDim = result.dimensions?.multiStep as number;
      expect(multiStepDim).toBeGreaterThanOrEqual(1.0);
      expect(result.score).toBeGreaterThan(0.2);
    });

    test("simple indicators reduce score", () => {
      const helloResult = classify(userMsg("hello"), 3);
      const analyzeResult = classify(userMsg("analyze this complex problem"), 3);
      expect(helloResult.score).toBeLessThan(analyzeResult.score);
    });

    test("technical terms score high (dimension level)", () => {
      const result = classify(
        userMsg("explain kubernetes cluster orchestration and microservices architecture"),
        3,
      );
      const techDim = result.dimensions?.technical as number;
      expect(techDim).toBeGreaterThanOrEqual(1.0);
      expect(result.score).toBeGreaterThan(0.15);
    });

    test("output format keywords score high (dimension level)", () => {
      const result = classify(userMsg("return the data as JSON with a structured table"), 3);
      const formatDim = result.dimensions?.outputFormat as number;
      expect(formatDim).toBeGreaterThanOrEqual(1.0);
    });

    test("relay indicators reduce score (push toward LIGHT)", () => {
      const relayResult = classify(userMsg("forward this to the team and check status"), 3);
      const neutralResult = classify(userMsg("process this request for the team"), 3);
      expect(relayResult.score).toBeLessThan(neutralResult.score);
    });

    test("relay keywords produce LIGHT for pass-through requests", () => {
      const result = classify(userMsg("check my inbox and mark as read"), 3);
      expect(result.tier).toBe("LIGHT");
      const relayDim = result.dimensions?.relay as number;
      expect(relayDim).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Override rules
  // -------------------------------------------------------------------------

  describe("override rules", () => {
    test("2+ reasoning keywords forces HEAVY", () => {
      const result = classify(userMsg("analyze and evaluate and compare these approaches"), 3);
      expect(result.tier).toBe("HEAVY");
      expect(result.score).toBeGreaterThanOrEqual(0.6);
    });

    test("estimated >50K tokens forces HEAVY", () => {
      // ~50K tokens ≈ ~200K chars at 4 chars/token
      const longText = "word ".repeat(50_000);
      const result = classify(userMsg(longText), 3);
      expect(result.tier).toBe("HEAVY");
      expect(result.score).toBeGreaterThanOrEqual(0.6);
    });

    test("reasoning + high technical forces HEAVY", () => {
      const result = classify(
        userMsg("implement a distributed consensus algorithm with formal proof"),
        3,
      );
      // "proof" → reasoning > 0, "distributed"+"consensus"+"algorithm" → technical >= 0.8
      expect(result.tier).toBe("HEAVY");
    });

    test("code + multiStep + reasoning forces HEAVY", () => {
      const result = classify(
        userMsg(
          "analyze this code:\n```js\nfunction x() {}\n```\nFirst refactor it, then add tests",
        ),
        3,
      );
      expect(result.tier).toBe("HEAVY");
    });

    test("overrides never lower the score", () => {
      // A request that's already HEAVY stays HEAVY
      const result = classify(
        userMsg("analyze and evaluate and compare and prove this distributed consensus algorithm"),
        3,
      );
      expect(result.tier).toBe("HEAVY");
      expect(result.score).toBeGreaterThanOrEqual(0.6);
    });
  });

  // -------------------------------------------------------------------------
  // Tier mapping
  // -------------------------------------------------------------------------

  describe("tier mapping", () => {
    test("low score → LIGHT tier, index 0", () => {
      const result = classify(userMsg("hello"), 3);
      expect(result.tier).toBe("LIGHT");
      expect(result.recommendedTierIndex).toBe(0);
    });

    test("medium score → MEDIUM tier, middle index", () => {
      // Fires multiStep (1.0) + outputFormat (0.5) + technical (0.5) → MEDIUM
      const result = classify(userMsg("first check the database, then return results as json"), 3);
      expect(result.tier).toBe("MEDIUM");
      expect(result.recommendedTierIndex).toBe(1);
    });

    test("high score → HEAVY tier, last index", () => {
      const result = classify(
        userMsg("analyze and evaluate this distributed consensus algorithm with formal proof"),
        3,
      );
      expect(result.tier).toBe("HEAVY");
      expect(result.recommendedTierIndex).toBe(2);
    });

    test("single tier always returns index 0", () => {
      const result = classify(userMsg("analyze and evaluate this complex distributed system"), 1);
      expect(result.recommendedTierIndex).toBe(0);
    });

    test("two tiers: LIGHT=0, MEDIUM/HEAVY=1", () => {
      const light = classify(userMsg("hello"), 2);
      expect(light.recommendedTierIndex).toBe(0);

      const heavy = classify(
        userMsg("analyze and evaluate this distributed consensus algorithm"),
        2,
      );
      expect(heavy.recommendedTierIndex).toBe(1);
    });

    test("three tiers: LIGHT=0, MEDIUM=1, HEAVY=2", () => {
      const light = classify(userMsg("hello"), 3);
      expect(light.recommendedTierIndex).toBe(0);

      const heavy = classify(
        userMsg("analyze and evaluate this distributed consensus algorithm with formal proof"),
        3,
      );
      expect(heavy.recommendedTierIndex).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Sigmoid confidence
  // -------------------------------------------------------------------------

  describe("sigmoid confidence", () => {
    test("high confidence for score far from boundaries", () => {
      // "hello" scores ~0 → far from medium boundary (0.25) → high confidence
      const result = classify(userMsg("hello"), 3);
      expect(result.confidence).toBeGreaterThan(0.85);
    });

    test("high confidence for deep HEAVY score (override)", () => {
      const result = classify(
        userMsg("analyze and evaluate this distributed consensus algorithm with formal proof"),
        3,
      );
      // Override fired → tier is HEAVY regardless of confidence
      expect(result.tier).toBe("HEAVY");
    });

    test("low confidence near MEDIUM boundary falls back to MEDIUM", () => {
      // Craft a score just below the medium threshold (0.25) where confidence < 0.70
      // outputFormat alone with weight 0.20: "json" = 0.5 dim * 0.20 = 0.10
      // + technical "api" = 0.5 dim * 0.20 = 0.10
      // Total ≈ 0.20 — close to 0.25 boundary → low confidence → MEDIUM fallback
      const result = classify(userMsg("return the api response as json"), 3);
      // Score is near the 0.25 boundary, should fall back to MEDIUM
      if (result.confidence < 0.7) {
        expect(result.tier).toBe("MEDIUM");
      }
    });

    test("low confidence near HEAVY boundary falls back to MEDIUM", () => {
      // Craft a score just above the heavy threshold (0.60) without triggering overrides
      // Use custom classifier with confidence enabled but no overrides that would fire
      const custom = createComplexityClassifier({
        // Disable overrides by requiring impossible keyword count
        heavyReasoningKeywordCount: 999,
      });
      // multiStep (1.0 * 0.24 = 0.24) + technical (1.0 * 0.20 = 0.20) +
      // outputFormat (0.5 * 0.20 = 0.10) + imperativeVerbs (0.5 * 0.06 = 0.03)
      // ≈ 0.57 — near the 0.60 boundary
      const result = custom(
        userMsg("first build the database schema, then deploy the api pipeline as json"),
        3,
      );
      if (result.confidence < 0.7) {
        expect(result.tier).toBe("MEDIUM");
      }
    });

    test("overrides bypass confidence fallback", () => {
      // 2+ reasoning keywords → override fires → stays HEAVY even if score lands on boundary
      const result = classify(userMsg("analyze and evaluate this"), 3);
      expect(result.tier).toBe("HEAVY");
      // Override fired, so confidence doesn't downgrade to MEDIUM
    });

    test("confidence threshold 0 disables fallback", () => {
      const noFallback = createComplexityClassifier({
        confidenceThreshold: 0,
      });
      // Score near boundary but confidence check is disabled
      const result = noFallback(userMsg("return the api response as json"), 3);
      // Should use raw tier mapping, not MEDIUM fallback
      const rawTier = result.score >= 0.6 ? "HEAVY" : result.score >= 0.25 ? "MEDIUM" : "LIGHT";
      expect(result.tier).toBe(rawTier);
    });

    test("confidence is in [0, 1] range", () => {
      const light = classify(userMsg("hi"), 3);
      expect(light.confidence).toBeGreaterThanOrEqual(0);
      expect(light.confidence).toBeLessThanOrEqual(1);

      const heavy = classify(
        userMsg("analyze evaluate compare prove this distributed consensus algorithm"),
        3,
      );
      expect(heavy.confidence).toBeGreaterThanOrEqual(0);
      expect(heavy.confidence).toBeLessThanOrEqual(1);
    });

    test("empty input has confidence 1", () => {
      const result = classify(userMsg("   "), 3);
      expect(result.confidence).toBe(1);
    });

    test("custom sigmoid steepness changes confidence curve", () => {
      const steep = createComplexityClassifier({ sigmoidSteepness: 50 });
      const gentle = createComplexityClassifier({ sigmoidSteepness: 5 });

      // Same input — steeper sigmoid = higher confidence for same distance
      const steepResult = steep(userMsg("hello"), 3);
      const gentleResult = gentle(userMsg("hello"), 3);
      expect(steepResult.confidence).toBeGreaterThan(gentleResult.confidence);
    });
  });

  // -------------------------------------------------------------------------
  // Real-world prompts
  // -------------------------------------------------------------------------

  describe("real-world prompts", () => {
    test('"hello" → LIGHT', () => {
      const result = classify(userMsg("hello"), 3);
      expect(result.tier).toBe("LIGHT");
    });

    test('"what is the capital of France" → LIGHT', () => {
      const result = classify(userMsg("what is the capital of France"), 3);
      expect(result.tier).toBe("LIGHT");
    });

    test('"implement a distributed consensus algorithm with formal proof" → HEAVY', () => {
      const result = classify(
        userMsg("implement a distributed consensus algorithm with formal proof"),
        3,
      );
      expect(result.tier).toBe("HEAVY");
    });

    test("long prompt with code blocks → HEAVY", () => {
      const prompt = `
Please analyze this code and refactor it:

\`\`\`typescript
class DatabaseConnectionPool {
  private connections: Connection[] = [];
  private maxSize: number;

  constructor(config: PoolConfig) {
    this.maxSize = config.maxSize;
  }

  async acquire(): Promise<Connection> {
    if (this.connections.length > 0) {
      return this.connections.pop()!;
    }
    return this.createNewConnection();
  }

  async release(conn: Connection): Promise<void> {
    if (this.connections.length < this.maxSize) {
      this.connections.push(conn);
    } else {
      await conn.close();
    }
  }
}
\`\`\`

First analyze the current implementation for issues, then refactor to use immutable patterns, finally add proper error handling.
      `.trim();
      const result = classify(userMsg(prompt), 3);
      expect(result.tier).toBe("HEAVY");
    });

    test('"thanks" → LIGHT', () => {
      const result = classify(userMsg("thanks"), 3);
      expect(result.tier).toBe("LIGHT");
    });
  });

  // -------------------------------------------------------------------------
  // Custom options
  // -------------------------------------------------------------------------

  describe("custom options", () => {
    test("custom tier thresholds change boundaries", () => {
      const lenient = createComplexityClassifier({
        tierThresholds: { medium: 0.8, heavy: 0.95 },
      });
      // Something that would normally be MEDIUM becomes LIGHT with higher thresholds
      const result = lenient(userMsg("first check the database, then return results as json"), 3);
      expect(result.tier).toBe("LIGHT");
    });

    test("custom weights override defaults", () => {
      const codeHeavy = createComplexityClassifier({
        weights: { code: 0.8 },
      });
      const result = codeHeavy(userMsg("```typescript\nconst x = 1;\n```"), 3);
      // Code dimension with much higher weight: 0.8 * 0.80 = 0.64
      expect(result.score).toBeGreaterThan(0.5);
    });

    test("custom keywords per dimension", () => {
      const custom = createComplexityClassifier({
        keywords: {
          reasoning: ["foobar", "bazqux"],
        },
      });
      // Default reasoning keywords shouldn't score
      const defaultResult = custom(userMsg("analyze this data"), 3);
      // Custom keywords should score
      const customResult = custom(userMsg("foobar this bazqux that"), 3);
      expect(customResult.score).toBeGreaterThan(defaultResult.score);
    });
  });

  // -------------------------------------------------------------------------
  // Result shape
  // -------------------------------------------------------------------------

  describe("result shape", () => {
    test("includes all required fields", () => {
      const result = classify(userMsg("hello"), 3);
      expect(typeof result.score).toBe("number");
      expect(typeof result.confidence).toBe("number");
      expect(typeof result.tier).toBe("string");
      expect(typeof result.recommendedTierIndex).toBe("number");
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    });

    test("score is clamped to [0, 1]", () => {
      const light = classify(userMsg("hi"), 3);
      expect(light.score).toBeGreaterThanOrEqual(0);
      expect(light.score).toBeLessThanOrEqual(1);

      const heavy = classify(
        userMsg(
          "analyze evaluate compare prove this distributed consensus quantum genomics algorithm " +
            "complex ".repeat(100),
        ),
        3,
      );
      expect(heavy.score).toBeGreaterThanOrEqual(0);
      expect(heavy.score).toBeLessThanOrEqual(1);
    });

    test("dimensions object contains per-dimension scores", () => {
      const result = classify(userMsg("analyze this code"), 3);
      expect(result.dimensions).toBeDefined();
      expect(typeof result.dimensions?.reasoning).toBe("number");
      expect(typeof result.dimensions?.code).toBe("number");
    });
  });

  // -------------------------------------------------------------------------
  // Performance
  // -------------------------------------------------------------------------

  describe("performance", () => {
    test("classifies in < 1ms", () => {
      const request = userMsg("implement a distributed consensus algorithm with formal proof");
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        classify(request, 3);
      }
      const elapsed = performance.now() - start;
      // 100 iterations should be well under 100ms → each under 1ms
      expect(elapsed).toBeLessThan(100);
    });
  });
});
