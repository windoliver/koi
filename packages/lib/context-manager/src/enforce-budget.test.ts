/**
 * Budget enforcement cascade tests.
 *
 * Tests the full deterministic pipeline:
 *   replacement (non-terminal) → noop/micro/full compaction signals.
 */

import { describe, expect, it } from "bun:test";
import { charEstimator, textMsg } from "./__tests__/test-helpers.js";
import type { BudgetConfig } from "./enforce-budget.js";
import { enforceBudget } from "./enforce-budget.js";
import { createInMemoryReplacementStore } from "./replacement.js";

/** Budget config with small window for easy testing. */
function testConfig(overrides?: Partial<BudgetConfig>): BudgetConfig {
  return {
    contextWindowSize: 100,
    preserveRecent: 2,
    tokenEstimator: charEstimator,
    softTriggerFraction: 0.5,
    hardTriggerFraction: 0.75,
    microTargetFraction: 0.35,
    maxResultTokens: 50,
    maxMessageTokens: 50_000,
    previewChars: 10,
    maxSummaryTokens: 10,
    ...overrides,
  };
}

describe("enforceBudget", () => {
  describe("replacement (non-terminal)", () => {
    it("replaces large tool result AND continues to budget check", async () => {
      const store = createInMemoryReplacementStore();
      // Large window so preview metadata doesn't push over thresholds
      const config = testConfig({
        contextWindowSize: 10_000,
        maxResultTokens: 100,
        previewChars: 50,
      });
      // Messages: 10 tokens — well under soft (5000)
      const messages = [textMsg("a".repeat(10))];

      // 2000 chars = 500 tokens > 100 token threshold
      const result = await enforceBudget(messages, store, config, "x".repeat(2000));

      // Replacement occurred
      expect(result.replacement).toBeDefined();
      expect(result.replacement?.tokensSaved).toBeGreaterThan(0);
      expect(result.replacement?.previews.length).toBe(1);
      expect(result.replacement?.activeRefs.size).toBe(1);

      // Budget check also ran — post-ingestion total is well under soft (5000)
      expect(result.compaction).toBe("noop");
    });

    it("replacement + micro: both fire when post-ingestion total exceeds soft", async () => {
      const store = createInMemoryReplacementStore();
      // Window: 1000, soft: 500, hard: 750
      const config = testConfig({
        contextWindowSize: 1000,
        maxResultTokens: 100,
        previewChars: 50,
      });

      // Messages at 550 tokens — above soft (500), below hard (750)
      const messages = [
        textMsg("a".repeat(110)),
        textMsg("b".repeat(110)),
        textMsg("c".repeat(110)),
        textMsg("d".repeat(110)),
        textMsg("e".repeat(110)),
      ];

      // Large tool result triggers replacement. Preview adds ~250 tokens.
      // Post-ingestion: 550 + ~250 = ~800 → above hard (750) → full
      // But messages alone: 550 → above soft → micro
      const result = await enforceBudget(messages, store, config, "x".repeat(2000));

      // Replacement should have fired
      expect(result.replacement).toBeDefined();
      // Compaction should also fire (at least micro, maybe full due to new result tokens)
      expect(result.compaction).not.toBe("noop");
    });

    it("new results push budget over threshold even when messages alone are under", async () => {
      const store = createInMemoryReplacementStore();
      // Window: 200, soft: 100, hard: 150. Messages: 60 tokens (under soft).
      // New result: small (not replaced), 50 chars = 50 tokens with charEstimator.
      // Post-ingestion: 60 + 50 = 110. 100 < 110 < 150 → micro.
      const config = testConfig({
        contextWindowSize: 200,
        maxResultTokens: 1000, // high threshold, no replacement
      });
      const messages = [textMsg("a".repeat(30)), textMsg("b".repeat(30))]; // 60 tokens

      // 50-char result = 50 tokens. Post-ingestion: 60 + 50 = 110 > soft (100)
      const result = await enforceBudget(messages, store, config, "x".repeat(50));

      // Budget check should see post-ingestion total and trigger micro
      expect(result.compaction).toBe("micro");
      // No replacement occurred (result too small)
      expect(result.replacement).toBeUndefined();
    });

    it("replacement + full: both fire when messages are over hard threshold", async () => {
      const store = createInMemoryReplacementStore();
      const config = testConfig({
        contextWindowSize: 1000,
        maxResultTokens: 100,
        previewChars: 50,
      });

      // Messages at 800 tokens — above hard (750)
      const messages = [
        textMsg("a".repeat(200)),
        textMsg("b".repeat(200)),
        textMsg("c".repeat(200)),
        textMsg("d".repeat(200)),
      ];

      const result = await enforceBudget(messages, store, config, "x".repeat(2000));

      expect(result.replacement).toBeDefined();
      expect(result.compaction).toBe("full");
    });

    it("does not replace small tool results", async () => {
      const store = createInMemoryReplacementStore();
      const config = testConfig({ maxResultTokens: 100 });
      const messages = [textMsg("a".repeat(10))];

      const result = await enforceBudget(messages, store, config, "small");

      expect(result.replacement).toBeUndefined();
      expect(result.compaction).toBe("noop");
    });

    it("skips replacement when no store provided", async () => {
      const config = testConfig({ maxResultTokens: 5 });
      const messages = [textMsg("a".repeat(10))];

      const result = await enforceBudget(messages, undefined, config, "x".repeat(1000));

      expect(result.replacement).toBeUndefined();
    });
  });

  describe("compaction: noop", () => {
    it("returns noop when tokens are below soft threshold", async () => {
      const config = testConfig();
      const messages = [textMsg("a".repeat(20))];

      const result = await enforceBudget(messages, undefined, config);

      expect(result.compaction).toBe("noop");
      if (result.compaction !== "noop") return;
      expect(result.totalTokens).toBe(20);
    });
  });

  describe("compaction: micro", () => {
    it("triggers microcompact at soft threshold", async () => {
      const config = testConfig();
      const messages = [
        textMsg("a".repeat(11)),
        textMsg("b".repeat(11)),
        textMsg("c".repeat(11)),
        textMsg("d".repeat(11)),
        textMsg("e".repeat(11)),
      ];

      const result = await enforceBudget(messages, undefined, config);

      expect(result.compaction).toBe("micro");
      if (result.compaction !== "micro") return;
      expect(result.originalTokens).toBe(55);
      expect(result.compactedTokens).toBeLessThanOrEqual(35);
      expect(result.messages.length).toBeLessThan(messages.length);
    });
  });

  describe("compaction: full", () => {
    it("triggers full compact at hard threshold", async () => {
      const config = testConfig();
      const messages = [
        textMsg("a".repeat(20)),
        textMsg("b".repeat(20)),
        textMsg("c".repeat(20)),
        textMsg("d".repeat(20)),
      ];

      const result = await enforceBudget(messages, undefined, config);

      expect(result.compaction).toBe("full");
      if (result.compaction !== "full") return;
      expect(result.totalTokens).toBe(80);
      expect(result.splitIdx).toBeGreaterThanOrEqual(1);
    });
  });

  describe("multi-result messages", () => {
    it("enforces per-message aggregate cap across multiple results", async () => {
      const store = createInMemoryReplacementStore();
      const config = testConfig({
        maxResultTokens: 100_000,
        maxMessageTokens: 10_000,
        previewChars: 100,
      });
      const messages = [textMsg("hello")];
      const results = ["a".repeat(20_000), "b".repeat(20_000), "c".repeat(20_000)];

      const result = await enforceBudget(messages, store, config, results);

      expect(result.replacement).toBeDefined();
      expect(result.replacement?.tokensSaved).toBeGreaterThan(0);
    });
  });

  describe("async store support", () => {
    it("aggregate cap works with async store", async () => {
      const syncStore = createInMemoryReplacementStore();
      const asyncStore: import("@koi/core/replacement").ReplacementStore = {
        async put(content: string) {
          return syncStore.put(content);
        },
        async get(ref: import("@koi/core/replacement").ReplacementRef) {
          return syncStore.get(ref);
        },
        async cleanup(activeRefs: ReadonlySet<import("@koi/core/replacement").ReplacementRef>) {
          return syncStore.cleanup(activeRefs);
        },
      };

      const config = testConfig({
        maxResultTokens: 100_000,
        maxMessageTokens: 10_000,
        previewChars: 100,
      });
      const messages = [textMsg("hello")];
      const results = ["a".repeat(20_000), "b".repeat(20_000), "c".repeat(20_000)];

      const result = await enforceBudget(messages, asyncStore, config, results);

      expect(result.replacement).toBeDefined();
      expect(result.replacement?.tokensSaved).toBeGreaterThan(0);
    });
  });

  describe("cleanup responsibility", () => {
    it("does NOT call store.cleanup — leaves to caller", async () => {
      const syncStore = createInMemoryReplacementStore();
      let cleanupCalled = false; // let: test spy flag
      const spyStore: import("@koi/core/replacement").ReplacementStore = {
        put(content: string) {
          return syncStore.put(content);
        },
        get(ref: import("@koi/core/replacement").ReplacementRef) {
          return syncStore.get(ref);
        },
        cleanup() {
          cleanupCalled = true;
        },
      };

      const config = testConfig({
        contextWindowSize: 1000,
        maxResultTokens: 100,
        previewChars: 50,
      });
      // Messages above soft (500) → micro will fire
      const messages = [
        textMsg("a".repeat(110)),
        textMsg("b".repeat(110)),
        textMsg("c".repeat(110)),
        textMsg("d".repeat(110)),
        textMsg("e".repeat(110)),
      ];

      await enforceBudget(messages, spyStore, config, "x".repeat(2000));

      expect(cleanupCalled).toBe(false);
    });
  });

  describe("ref tracking (format-agnostic)", () => {
    it("replacement info contains refs from collectRefsFromOutcomes", async () => {
      const store = createInMemoryReplacementStore();
      const config = testConfig({
        contextWindowSize: 10_000,
        maxResultTokens: 100,
        previewChars: 50,
      });
      const messages = [textMsg("hello")];

      const result = await enforceBudget(messages, store, config, "x".repeat(2000));

      expect(result.replacement).toBeDefined();
      // activeRefs should contain exactly the refs produced by replacement
      expect(result.replacement?.activeRefs.size).toBe(1);
      // Refs should be usable with the store
      for (const ref of result.replacement?.activeRefs ?? []) {
        expect(store.get(ref)).toBe("x".repeat(2000));
      }
    });
  });

  describe("determinism", () => {
    it("same inputs always produce same output", async () => {
      const config = testConfig();
      const messages = [textMsg("a".repeat(20)), textMsg("b".repeat(20)), textMsg("c".repeat(20))];

      const result1 = await enforceBudget(messages, undefined, config);
      const result2 = await enforceBudget(messages, undefined, config);

      expect(result1.compaction).toBe(result2.compaction);
      if (result1.compaction === "micro" && result2.compaction === "micro") {
        expect(result1.compactedTokens).toBe(result2.compactedTokens);
      }
    });
  });

  describe("defaults", () => {
    it("works with no config (all defaults)", async () => {
      const messages = [textMsg("hello"), textMsg("world")];
      const result = await enforceBudget(messages);
      expect(result.compaction).toBe("noop");
    });
  });
});
