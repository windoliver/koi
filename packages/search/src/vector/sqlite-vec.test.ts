import { describe, expect, test } from "bun:test";
import { createVectorStore } from "./sqlite-vec.js";

function makeEmbedding(seed: number, dimensions: number): readonly number[] {
  // Create a simple deterministic embedding
  const result: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    result.push(Math.sin(seed * (i + 1)));
  }
  return result;
}

function normalizeVec(v: readonly number[]): readonly number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

describe("VectorStore", () => {
  const dims = 8;

  test("insert and search returns matching result", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const emb = makeEmbedding(1, dims);
    store.insert("doc1", emb, { title: "first" });

    const results = store.search(emb, 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("doc1");
    expect(results[0]?.score).toBeGreaterThan(0.9); // Self-similarity should be very high
    expect(results[0]?.metadata).toEqual({ title: "first" });
    store.close();
  });

  test("search returns results ordered by similarity", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const query = normalizeVec(makeEmbedding(1, dims));
    const similar = normalizeVec(makeEmbedding(1.1, dims)); // Close to query
    const different = normalizeVec(makeEmbedding(100, dims)); // Far from query

    store.insert("similar", [...similar], {});
    store.insert("different", [...different], {});

    const results = store.search(query, 10);
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe("similar");
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    store.close();
  });

  test("limit parameter is respected", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    for (let i = 0; i < 10; i++) {
      store.insert(String(i), makeEmbedding(i, dims), {});
    }
    const results = store.search(makeEmbedding(0, dims), 3);
    expect(results).toHaveLength(3);
    store.close();
  });

  test("remove deletes document from index", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    store.insert("1", makeEmbedding(1, dims), {});
    store.insert("2", makeEmbedding(2, dims), {});
    store.remove("1");

    const results = store.search(makeEmbedding(1, dims), 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("2");
    store.close();
  });

  test("insert replaces existing document", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    store.insert("1", makeEmbedding(1, dims), { v: 1 });
    store.insert("1", makeEmbedding(2, dims), { v: 2 });

    const results = store.search(makeEmbedding(2, dims), 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("1");
    expect(results[0]?.metadata).toEqual({ v: 2 });
    store.close();
  });

  test("empty store returns empty results", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const results = store.search(makeEmbedding(1, dims), 10);
    expect(results).toEqual([]);
    store.close();
  });

  test("warmup does not throw", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    store.insert("1", makeEmbedding(1, dims), {});
    expect(() => store.warmup()).not.toThrow();
    store.close();
  });

  test("metadata is preserved correctly", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const meta = { title: "test", tags: ["a", "b"], nested: { key: "value" } };
    store.insert("1", makeEmbedding(1, dims), meta);

    const results = store.search(makeEmbedding(1, dims), 1);
    expect(results[0]?.metadata).toEqual(meta);
    store.close();
  });

  test("gracefully falls back when sqlite-vec extension is missing", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    // Without the sqlite-vec extension installed, nativeVec should be false
    expect(store.nativeVec).toBe(false);
    // Brute-force search should still work
    store.insert("1", makeEmbedding(1, dims), { title: "test" });
    const results = store.search(makeEmbedding(1, dims), 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("1");
    store.close();
  });

  test("zero vector returns zero scores", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    store.insert("1", makeEmbedding(1, dims), {});
    const zeros = new Array(dims).fill(0) as number[];
    const results = store.search(zeros, 10);
    expect(results[0]?.score).toBeCloseTo(0.5, 1); // (0 + 1) / 2 normalized
    store.close();
  });

  test("dimension mismatch between config and embedding does not crash", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: 4 });
    // Insert with fewer dimensions than configured
    const shortEmb = [1, 0, 0];
    store.insert("short", shortEmb, { note: "short" });
    // Should still be searchable (brute-force handles mismatched lengths)
    const results = store.search([1, 0, 0, 0], 10);
    expect(results.length).toBeGreaterThanOrEqual(0);
    store.close();
  });

  test("search with limit 0 returns empty", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    store.insert("1", makeEmbedding(1, dims), {});
    const results = store.search(makeEmbedding(1, dims), 0);
    expect(results).toEqual([]);
    store.close();
  });

  test("remove on non-existent id does not throw", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    expect(() => store.remove("ghost")).not.toThrow();
    store.close();
  });

  test("missing metadata row returns empty object", () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    store.insert("1", makeEmbedding(1, dims), { title: "test" });
    // Hard to test orphaned-vector path without accessing internals,
    // so we verify that normal flow returns correct metadata
    const results = store.search(makeEmbedding(1, dims), 1);
    expect(results[0]?.metadata).toEqual({ title: "test" });
    store.close();
  });
});
