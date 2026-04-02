/**
 * Replacement + compaction interaction tests.
 *
 * Verifies that content replacement and compaction compose correctly
 * when operating on the same conversation.
 */

import { describe, expect, it } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { shouldCompact } from "../policy.js";
import {
  collectRefsFromOutcomes,
  createInMemoryReplacementStore,
  evaluateReplacement,
} from "../replacement.js";
import { charEstimator, textMsg } from "./test-helpers.js";

describe("replacement + compaction interaction", () => {
  it("compaction estimates tokens on preview, not original content", async () => {
    const store = createInMemoryReplacementStore();

    // Simulate: a 60K-char tool result gets replaced with a ~2K preview
    const largeContent = "x".repeat(60_000);
    const outcome = evaluateReplacement(largeContent, store, { maxResultTokens: 5000 });
    if (outcome instanceof Promise || !outcome.replaced) {
      expect.unreachable("expected sync replacement");
      return;
    }

    // Build a conversation where the replaced result is a message
    const messages: readonly InboundMessage[] = [
      textMsg("user prompt"),
      textMsg(outcome.preview, "tool"), // preview, not original
      textMsg("follow-up"),
      textMsg("response", "assistant"),
    ];

    // Token count should reflect preview size, not 60K
    const totalTokens = charEstimator.estimateMessages(messages) as number;
    expect(totalTokens).toBeLessThan(10_000); // preview is ~2K chars
    expect(totalTokens).toBeLessThan(60_000); // definitely less than original

    // Verify compaction decision uses the preview-based count
    const decision = shouldCompact(totalTokens, 20_000, 0.5, 0.75);
    expect(decision).toBe("noop"); // ~2K tokens << 10K soft threshold
  });

  it("compaction drops messages — cleanup via collectRefsFromOutcomes removes orphans", async () => {
    const store = createInMemoryReplacementStore();

    // Replace a large result and get the ref
    const largeContent = `important data ${"x".repeat(60_000)}`;
    const outcome = evaluateReplacement(largeContent, store, { maxResultTokens: 5000 });
    if (outcome instanceof Promise || !outcome.replaced) {
      expect.unreachable("expected sync replacement");
      return;
    }

    // Verify content is in the store
    expect(store.get(outcome.ref)).toBe(largeContent);

    // Track refs from outcomes (format-agnostic)
    const allRefs = collectRefsFromOutcomes([outcome]);
    expect(allRefs.size).toBe(1);

    // After compaction drops the message, caller passes empty active set → cleanup removes it
    store.cleanup(new Set()); // no active refs
    expect(store.get(outcome.ref)).toBeUndefined();
  });

  it("collectRefsFromOutcomes produces refs usable with store", () => {
    const store = createInMemoryReplacementStore();
    const content = "x".repeat(60_000);
    const outcome = evaluateReplacement(content, store, { maxResultTokens: 5000 });
    if (outcome instanceof Promise || !outcome.replaced) {
      expect.unreachable("expected sync replacement");
      return;
    }

    // Refs from outcomes should round-trip through the store
    const refs = collectRefsFromOutcomes([outcome]);
    for (const ref of refs) {
      expect(store.get(ref)).toBe(content);
    }
  });

  it("dual trigger: single large result triggers replacement, not compaction", () => {
    const store = createInMemoryReplacementStore();

    // A single 60K-char result: 15,000 tokens
    // Context window: 20,000. Soft threshold: 50% = 10,000. Hard: 75% = 15,000.
    // Without replacement: 15,000 tokens → triggers full compact.
    // With replacement: preview ~500 tokens → noop.
    const content = "x".repeat(60_000);
    const outcome = evaluateReplacement(content, store, { maxResultTokens: 5000 });
    if (outcome instanceof Promise || !outcome.replaced) {
      expect.unreachable("expected sync replacement");
      return;
    }

    // Without replacement: original would hit hard threshold
    const originalTokens = Math.ceil(60_000 / 4); // 15,000
    const decisionWithout = shouldCompact(originalTokens, 20_000, 0.5, 0.75);
    expect(decisionWithout).toBe("full");

    // With replacement: preview is small, well under threshold
    const previewTokens = outcome.previewTokens;
    const decisionWith = shouldCompact(previewTokens, 20_000, 0.5, 0.75);
    expect(decisionWith).toBe("noop");
  });
});
