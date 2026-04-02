/**
 * Content replacement tests — preview generation, evaluation, store interaction.
 */

import { describe, expect, it } from "bun:test";
import type { ReplacementRef } from "@koi/core/replacement";
import { replacementRef } from "@koi/core/replacement";
import {
  collectRefsFromOutcomes,
  createInMemoryReplacementStore,
  evaluateMessageResults,
  evaluateReplacement,
  extractRefsFromTexts,
  generatePreview,
} from "./replacement.js";

describe("generatePreview", () => {
  it("includes size metadata and truncated content", () => {
    const content = "a".repeat(10_000);
    const ref = replacementRef("abc123");
    const preview = generatePreview(content, ref, 2048, 2500);
    expect(preview).toContain("10,000 chars");
    expect(preview).toContain("2,500 tokens");
    expect(preview).toContain("ref:abc123");
    expect(preview).toContain("2,048 chars");
    // Preview text should be truncated
    expect(preview.length).toBeLessThan(content.length);
  });

  it("uses the first previewChars characters", () => {
    const content = `ABCDE${"x".repeat(10_000)}`;
    const ref = replacementRef("def456");
    const preview = generatePreview(content, ref, 5, 2500);
    expect(preview).toContain("ABCDE");
    expect(preview).not.toContain("x".repeat(100));
  });
});

describe("createInMemoryReplacementStore", () => {
  it("round-trips: put then get returns original content", () => {
    const store = createInMemoryReplacementStore();
    const content = "hello world";
    const ref = store.put(content) as ReplacementRef;
    expect(store.get(ref)).toBe(content);
  });

  it("returns undefined for unknown ref", () => {
    const store = createInMemoryReplacementStore();
    expect(store.get(replacementRef("nonexistent"))).toBeUndefined();
  });

  it("is idempotent: same content produces same ref", () => {
    const store = createInMemoryReplacementStore();
    const ref1 = store.put("same content") as ReplacementRef;
    const ref2 = store.put("same content") as ReplacementRef;
    expect(ref1).toBe(ref2);
  });

  it("different content produces different refs", () => {
    const store = createInMemoryReplacementStore();
    const ref1 = store.put("content A") as ReplacementRef;
    const ref2 = store.put("content B") as ReplacementRef;
    expect(ref1).not.toBe(ref2);
  });

  it("cleanup removes unreferenced content", () => {
    const store = createInMemoryReplacementStore();
    const ref1 = store.put("keep this") as ReplacementRef;
    const ref2 = store.put("remove this") as ReplacementRef;

    store.cleanup(new Set([ref1]));

    expect(store.get(ref1)).toBe("keep this");
    expect(store.get(ref2)).toBeUndefined();
  });

  it("cleanup with empty set removes everything", () => {
    const store = createInMemoryReplacementStore();
    const ref = store.put("content") as ReplacementRef;
    store.cleanup(new Set());
    expect(store.get(ref)).toBeUndefined();
  });
});

describe("evaluateReplacement", () => {
  const store = createInMemoryReplacementStore();

  it("returns replaced:false for small content", () => {
    const result = evaluateReplacement("hello", store);
    expect(result).toEqual({ replaced: false });
  });

  it("returns replaced:false for content just under threshold", () => {
    // Default maxResultTokens = 12,500. At 4 chars/token = 50,000 chars threshold.
    const content = "a".repeat(49_999);
    const result = evaluateReplacement(content, store);
    expect(result).toEqual({ replaced: false });
  });

  it("replaces content above threshold", () => {
    // 60,000 chars = 15,000 tokens > 12,500 default threshold
    const content = "a".repeat(60_000);
    const result = evaluateReplacement(content, store);
    expect(result).not.toEqual({ replaced: false });
    if (!("replaced" in result) || !result.replaced) return;
    expect(result.replaced).toBe(true);
    expect(result.preview).toContain("60,000 chars");
    expect(result.originalTokens).toBe(15_000);
    expect(result.previewTokens).toBeGreaterThan(0);
    expect(result.previewTokens).toBeLessThan(result.originalTokens);
    // Verify content was stored
    expect(store.get(result.ref)).toBe(content);
  });

  it("respects custom maxResultTokens", () => {
    // 100 chars = 25 tokens. Set threshold to 20 tokens → should replace
    const content = "a".repeat(100);
    const result = evaluateReplacement(content, store, { maxResultTokens: 20 });
    if (!("replaced" in result) || !result.replaced) {
      expect.unreachable("expected replacement");
      return;
    }
    expect(result.replaced).toBe(true);
    expect(result.originalTokens).toBe(25);
  });

  it("respects custom previewChars", () => {
    const content = `ABCDE${"x".repeat(1000)}`;
    const result = evaluateReplacement(content, store, {
      maxResultTokens: 100,
      previewChars: 5,
    });
    if (!("replaced" in result) || !result.replaced) {
      expect.unreachable("expected replacement");
      return;
    }
    expect(result.preview).toContain("ABCDE");
    expect(result.preview).not.toContain("x".repeat(100));
  });

  it("short-circuits: small content skips without token estimation", () => {
    // Content with 10 chars is always below any reasonable threshold
    const result = evaluateReplacement("tiny", store, { maxResultTokens: 1000 });
    expect(result).toEqual({ replaced: false });
  });

  it("replaces content under 4-chars/token threshold when estimator is stricter", () => {
    // 1-char-per-token estimator: 390 chars = 390 tokens > 100 threshold
    // This is below the old fast-path cutoff of maxResultTokens * 4 = 400 chars,
    // which would have wrongly short-circuited to replaced:false.
    const charEstimator = {
      estimateText: (text: string) => text.length,
      estimateMessages: () => 0,
    };
    const content = "a".repeat(390);
    const result = evaluateReplacement(content, store, {
      maxResultTokens: 100,
      tokenEstimator: charEstimator,
    });
    if (!("replaced" in result) || !result.replaced) {
      expect.unreachable("expected replacement with strict estimator");
      return;
    }
    expect(result.replaced).toBe(true);
    expect(result.originalTokens).toBe(390);
  });
});

describe("evaluateMessageResults", () => {
  it("returns all replaced:false when all results are small", async () => {
    const store = createInMemoryReplacementStore();
    const result = await evaluateMessageResults(["small", "also small"], store);
    expect(result.outcomes.every((o) => !o.replaced)).toBe(true);
    expect(result.totalSavedTokens).toBe(0);
    expect(result.aggregateCapApplied).toBe(false);
  });

  it("replaces individual results exceeding per-result threshold", async () => {
    const store = createInMemoryReplacementStore();
    const big = "a".repeat(60_000); // 15,000 tokens > 12,500 default
    const small = "b".repeat(100); // 25 tokens
    const result = await evaluateMessageResults([big, small], store);
    expect(result.outcomes[0]?.replaced).toBe(true);
    expect(result.outcomes[1]?.replaced).toBe(false);
    expect(result.totalSavedTokens).toBeGreaterThan(0);
  });

  it("applies aggregate cap when combined results exceed per-message threshold", async () => {
    const store = createInMemoryReplacementStore();
    // 5 results of 160,000 chars each = 40,000 tokens each.
    // Per-result threshold: set high (100,000) so no individual replacement.
    // Per-message threshold: 100,000 tokens. Total: 200,000 > 100,000.
    // Aggregate cap should kick in and replace the largest.
    const results = Array.from({ length: 5 }, () => "x".repeat(160_000));
    const outcome = await evaluateMessageResults(results, store, {
      maxResultTokens: 100_000,
      maxMessageTokens: 100_000,
      previewChars: 512,
    });
    expect(outcome.aggregateCapApplied).toBe(true);
    expect(outcome.outcomes.some((o) => o.replaced)).toBe(true);
  });

  it("enforces aggregate cap with async store", async () => {
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

    // 3 results of 160K chars = 40K tokens each. Per-result: 100K (no individual replace).
    // Per-message: 80K. Total: 120K > 80K → aggregate cap must fire.
    const results = Array.from({ length: 3 }, () => "x".repeat(160_000));
    const outcome = await evaluateMessageResults(results, asyncStore, {
      maxResultTokens: 100_000,
      maxMessageTokens: 80_000,
      previewChars: 512,
    });
    expect(outcome.aggregateCapApplied).toBe(true);
    expect(outcome.outcomes.some((o) => o.replaced)).toBe(true);
  });
});

describe("collectRefsFromOutcomes", () => {
  it("collects refs from replaced outcomes", () => {
    const ref1 = replacementRef("abc123");
    const ref2 = replacementRef("def456");
    const outcomes = [
      {
        replaced: true as const,
        preview: "...",
        ref: ref1,
        originalTokens: 100,
        previewTokens: 10,
      },
      { replaced: false as const },
      {
        replaced: true as const,
        preview: "...",
        ref: ref2,
        originalTokens: 200,
        previewTokens: 20,
      },
    ];
    const refs = collectRefsFromOutcomes(outcomes);
    expect(refs.size).toBe(2);
    expect(refs.has(ref1)).toBe(true);
    expect(refs.has(ref2)).toBe(true);
  });

  it("returns empty set when no replacements", () => {
    const outcomes = [{ replaced: false as const }, { replaced: false as const }];
    const refs = collectRefsFromOutcomes(outcomes);
    expect(refs.size).toBe(0);
  });

  it("handles empty outcomes array", () => {
    const refs = collectRefsFromOutcomes([]);
    expect(refs.size).toBe(0);
  });

  it("works with non-hex ref formats (format-agnostic)", () => {
    // Simulates a custom store that uses UUIDs or paths instead of SHA-256
    const customRef = replacementRef("file:///tmp/store/item-42");
    const outcomes = [
      {
        replaced: true as const,
        preview: "...",
        ref: customRef,
        originalTokens: 100,
        previewTokens: 10,
      },
    ];
    const refs = collectRefsFromOutcomes(outcomes);
    expect(refs.size).toBe(1);
    expect(refs.has(customRef)).toBe(true);
  });
});

describe("extractRefsFromTexts", () => {
  it("extracts refs from preview text", () => {
    const hash = "a".repeat(64);
    const preview = `[Full content stored as ref:${hash}. Use retrieval tool to access.]`;
    const refs = extractRefsFromTexts([preview]);
    expect(refs.size).toBe(1);
    expect(refs.has(replacementRef(hash))).toBe(true);
  });

  it("extracts multiple refs from multiple texts", () => {
    const hash1 = "a".repeat(64);
    const hash2 = "b".repeat(64);
    const refs = extractRefsFromTexts([`ref:${hash1} some text`, `other text ref:${hash2}`]);
    expect(refs.size).toBe(2);
  });

  it("deduplicates identical refs", () => {
    const hash = "c".repeat(64);
    const refs = extractRefsFromTexts([`ref:${hash}`, `ref:${hash}`]);
    expect(refs.size).toBe(1);
  });

  it("returns empty set for text without refs", () => {
    const refs = extractRefsFromTexts(["no refs here", "just plain text"]);
    expect(refs.size).toBe(0);
  });

  it("ignores partial or malformed refs", () => {
    const refs = extractRefsFromTexts([
      "ref:tooshort",
      `ref:${"g".repeat(64)}`, // 'g' is not hex
    ]);
    expect(refs.size).toBe(0);
  });

  it("round-trips with generatePreview", () => {
    const store = createInMemoryReplacementStore();
    const content = "x".repeat(60_000);
    const result = evaluateReplacement(content, store);
    if (!("replaced" in result) || !result.replaced) {
      expect.unreachable("expected replacement");
      return;
    }
    // Extract ref from the preview text
    const extracted = extractRefsFromTexts([result.preview]);
    expect(extracted.size).toBe(1);
    expect(extracted.has(result.ref)).toBe(true);
    // Verify content is still retrievable
    expect(store.get(result.ref)).toBe(content);
  });
});
