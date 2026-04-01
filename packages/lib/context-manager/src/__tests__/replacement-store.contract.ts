/**
 * ReplacementStore contract test suite.
 *
 * Any implementation of ReplacementStore must pass these tests.
 * Usage:
 *   runReplacementStoreContract(() => createMyStore());
 */

import { describe, expect, it } from "bun:test";
import type { ReplacementStore } from "@koi/core/replacement";
import { replacementRef } from "@koi/core/replacement";

/**
 * Run the full ReplacementStore behavioral contract against a factory.
 *
 * @param factory — Creates a fresh store for each test.
 * @param suiteName — Optional name prefix for the describe block.
 */
export function runReplacementStoreContract(
  factory: () => ReplacementStore,
  suiteName = "ReplacementStore contract",
): void {
  describe(suiteName, () => {
    it("round-trips: put then get returns original content", async () => {
      const store = factory();
      const content = "hello world, this is a test";
      const ref = await store.put(content);
      const retrieved = await store.get(ref);
      expect(retrieved).toBe(content);
    });

    it("get returns undefined for unknown ref", async () => {
      const store = factory();
      const result = await store.get(replacementRef("0".repeat(64)));
      expect(result).toBeUndefined();
    });

    it("put is idempotent: same content always returns the same ref", async () => {
      const store = factory();
      const content = "identical content";
      const ref1 = await store.put(content);
      const ref2 = await store.put(content);
      expect(ref1).toBe(ref2);
    });

    it("different content produces different refs", async () => {
      const store = factory();
      const ref1 = await store.put("content A");
      const ref2 = await store.put("content B");
      expect(ref1).not.toBe(ref2);
    });

    it("handles empty string content", async () => {
      const store = factory();
      const ref = await store.put("");
      const retrieved = await store.get(ref);
      expect(retrieved).toBe("");
    });

    it("handles large content (>100KB)", async () => {
      const store = factory();
      const large = "x".repeat(200_000);
      const ref = await store.put(large);
      const retrieved = await store.get(ref);
      expect(retrieved).toBe(large);
    });

    it("handles Unicode content (CJK, emoji, combining marks)", async () => {
      const store = factory();
      const unicode = "こんにちは 🌊 café résumé naïve e\u0301";
      const ref = await store.put(unicode);
      const retrieved = await store.get(ref);
      expect(retrieved).toBe(unicode);
    });

    it("cleanup removes unreferenced content", async () => {
      const store = factory();
      const ref1 = await store.put("keep this");
      const ref2 = await store.put("remove this");
      await store.cleanup(new Set([ref1]));
      expect(await store.get(ref1)).toBe("keep this");
      expect(await store.get(ref2)).toBeUndefined();
    });

    it("cleanup with empty set removes everything", async () => {
      const store = factory();
      const ref = await store.put("soon gone");
      await store.cleanup(new Set());
      expect(await store.get(ref)).toBeUndefined();
    });

    it("cleanup preserves all content when all refs are active", async () => {
      const store = factory();
      const ref1 = await store.put("content 1");
      const ref2 = await store.put("content 2");
      await store.cleanup(new Set([ref1, ref2]));
      expect(await store.get(ref1)).toBe("content 1");
      expect(await store.get(ref2)).toBe("content 2");
    });
  });
}
