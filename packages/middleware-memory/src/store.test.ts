import { describe, expect, test } from "bun:test";
import { createInMemoryStore } from "./store.js";

describe("InMemoryStore", () => {
  test("store and recall round-trip", async () => {
    const store = createInMemoryStore();
    await store.store("s1", "The sky is blue");
    const results = await store.recall("sky", 4000);
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("The sky is blue");
  });

  test("empty recall returns empty array", async () => {
    const store = createInMemoryStore();
    const results = await store.recall("anything", 4000);
    expect(results).toHaveLength(0);
  });

  test("token budget enforcement", async () => {
    const store = createInMemoryStore();
    // Each entry ~25 chars = ~7 tokens
    await store.store("s1", "Entry one: short content.");
    await store.store("s1", "Entry two: short content.");
    await store.store("s1", "Entry three: short content");
    await store.store("s1", "Entry four: short content.");

    // With budget of ~7 tokens, should only get 1 entry
    const results = await store.recall("test", 7);
    expect(results).toHaveLength(1);
  });

  test("recency ordering — most recent first", async () => {
    const store = createInMemoryStore();
    await store.store("s1", "first");
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await store.store("s1", "second");
    await new Promise((r) => setTimeout(r, 10));
    await store.store("s1", "third");

    const results = await store.recall("test", 4000);
    expect(results[0]?.content).toBe("third");
    expect(results[1]?.content).toBe("second");
    expect(results[2]?.content).toBe("first");
  });

  test("stores metadata", async () => {
    const store = createInMemoryStore();
    await store.store("s1", "with meta", { key: "value" });
    const results = await store.recall("test", 4000);
    expect(results[0]?.metadata).toEqual({ key: "value" });
  });

  test("multiple entries accumulate", async () => {
    const store = createInMemoryStore();
    await store.store("s1", "one");
    await store.store("s1", "two");
    await store.store("s1", "three");
    const results = await store.recall("test", 4000);
    expect(results).toHaveLength(3);
  });

  test("large entry that exceeds budget returns nothing", async () => {
    const store = createInMemoryStore();
    const largeContent = "x".repeat(1000); // ~250 tokens
    await store.store("s1", largeContent);
    const results = await store.recall("test", 10); // only 10 token budget
    expect(results).toHaveLength(0);
  });
});
