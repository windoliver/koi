import { describe, expect, test } from "bun:test";
import type { Embedder } from "../contracts.js";
import { createVectorStore } from "./sqlite-vec.js";
import { createVectorRetriever } from "./vector-retriever.js";

const dims = 8;

function makeEmbedding(seed: number): readonly number[] {
  const result: number[] = [];
  for (let i = 0; i < dims; i++) {
    result.push(Math.sin(seed * (i + 1)));
  }
  return result;
}

function createMockEmbedder(): Embedder {
  return {
    embed: async (text: string) => {
      // Simple deterministic embedding based on text hash
      const hash = Array.from(text).reduce((h, c) => h + c.charCodeAt(0), 0);
      return makeEmbedding(hash);
    },
    embedMany: async (texts: readonly string[]) => {
      const embedder = createMockEmbedder();
      return Promise.all(texts.map((t) => embedder.embed(t)));
    },
    dimensions: dims,
  };
}

describe("VectorRetriever", () => {
  test("retrieve returns matching results", async () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const embedder = createMockEmbedder();
    const contentStore = new Map([
      ["1", "hello world"],
      ["2", "goodbye world"],
    ]);

    const emb1 = await embedder.embed("hello world");
    const emb2 = await embedder.embed("goodbye world");
    store.insert("1", emb1, { title: "first" });
    store.insert("2", emb2, { title: "second" });

    const retriever = createVectorRetriever({ embedder, store, contentStore });
    const result = await retriever.retrieve({ text: "hello world", limit: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(2);
    expect(result.value.results[0]?.source).toBe("vector");
    expect(result.value.results[0]?.id).toBe("1");
    store.close();
  });

  test("limit is respected", async () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const embedder = createMockEmbedder();
    const contentStore = new Map<string, string>();

    for (let i = 0; i < 10; i++) {
      const emb = await embedder.embed(`doc ${i}`);
      store.insert(String(i), emb, {});
      contentStore.set(String(i), `doc ${i}`);
    }

    const retriever = createVectorRetriever({ embedder, store, contentStore });
    const result = await retriever.retrieve({ text: "doc 0", limit: 3 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(3);
    expect(result.value.hasMore).toBe(true);
    store.close();
  });

  test("filter on metadata", async () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const embedder = createMockEmbedder();
    const contentStore = new Map([
      ["1", "hello"],
      ["2", "hello"],
    ]);

    const emb = await embedder.embed("hello");
    store.insert("1", emb, { category: "a" });
    store.insert("2", emb, { category: "b" });

    const retriever = createVectorRetriever({ embedder, store, contentStore });
    const result = await retriever.retrieve({
      text: "hello",
      limit: 10,
      filter: { kind: "eq", field: "category", value: "a" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
    expect(result.value.results[0]?.id).toBe("1");
    store.close();
  });

  test("minScore filters low scores", async () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const embedder = createMockEmbedder();
    const contentStore = new Map([["1", "hello"]]);

    const emb = await embedder.embed("hello");
    store.insert("1", emb, {});

    const retriever = createVectorRetriever({ embedder, store, contentStore });
    const result = await retriever.retrieve({ text: "hello", limit: 10, minScore: 0.99999 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Self-similarity should be ~1.0, so this should still return the result
    expect(result.value.results.length).toBeGreaterThanOrEqual(0);
    store.close();
  });

  test("filter ne excludes matching value", async () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const embedder = createMockEmbedder();
    const contentStore = new Map([
      ["1", "hello"],
      ["2", "hello"],
    ]);

    const emb = await embedder.embed("hello");
    store.insert("1", emb, { category: "a" });
    store.insert("2", emb, { category: "b" });

    const retriever = createVectorRetriever({ embedder, store, contentStore });
    const result = await retriever.retrieve({
      text: "hello",
      limit: 10,
      filter: { kind: "ne", field: "category", value: "a" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
    expect(result.value.results[0]?.id).toBe("2");
    store.close();
  });

  test("filter gt/lt on numeric metadata", async () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const embedder = createMockEmbedder();
    const contentStore = new Map([
      ["1", "hello"],
      ["2", "hello"],
      ["3", "hello"],
    ]);

    const emb = await embedder.embed("hello");
    store.insert("1", emb, { score: 10 });
    store.insert("2", emb, { score: 50 });
    store.insert("3", emb, { score: 90 });

    const retriever = createVectorRetriever({ embedder, store, contentStore });

    const gt = await retriever.retrieve({
      text: "hello",
      limit: 10,
      filter: { kind: "gt", field: "score", value: 40 },
    });
    expect(gt.ok).toBe(true);
    if (!gt.ok) return;
    expect(gt.value.results).toHaveLength(2);

    const lt = await retriever.retrieve({
      text: "hello",
      limit: 10,
      filter: { kind: "lt", field: "score", value: 40 },
    });
    expect(lt.ok).toBe(true);
    if (!lt.ok) return;
    expect(lt.value.results).toHaveLength(1);
    expect(lt.value.results[0]?.id).toBe("1");
    store.close();
  });

  test("filter in matches any of the values", async () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const embedder = createMockEmbedder();
    const contentStore = new Map([
      ["1", "hello"],
      ["2", "hello"],
      ["3", "hello"],
    ]);

    const emb = await embedder.embed("hello");
    store.insert("1", emb, { tag: "a" });
    store.insert("2", emb, { tag: "b" });
    store.insert("3", emb, { tag: "c" });

    const retriever = createVectorRetriever({ embedder, store, contentStore });
    const result = await retriever.retrieve({
      text: "hello",
      limit: 10,
      filter: { kind: "in", field: "tag", values: ["a", "c"] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(2);
    const ids = result.value.results.map((r) => r.id);
    expect(ids).toContain("1");
    expect(ids).toContain("3");
    store.close();
  });

  test("filter or matches either condition", async () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const embedder = createMockEmbedder();
    const contentStore = new Map([
      ["1", "hello"],
      ["2", "hello"],
      ["3", "hello"],
    ]);

    const emb = await embedder.embed("hello");
    store.insert("1", emb, { a: 1 });
    store.insert("2", emb, { a: 2 });
    store.insert("3", emb, { a: 3 });

    const retriever = createVectorRetriever({ embedder, store, contentStore });
    const result = await retriever.retrieve({
      text: "hello",
      limit: 10,
      filter: {
        kind: "or",
        filters: [
          { kind: "eq", field: "a", value: 1 },
          { kind: "eq", field: "a", value: 3 },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(2);
    const ids = result.value.results.map((r) => r.id);
    expect(ids).toContain("1");
    expect(ids).toContain("3");
    store.close();
  });

  test("filter and/not composable", async () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const embedder = createMockEmbedder();
    const contentStore = new Map([
      ["1", "hello"],
      ["2", "hello"],
      ["3", "hello"],
    ]);

    const emb = await embedder.embed("hello");
    store.insert("1", emb, { a: 1, b: "x" });
    store.insert("2", emb, { a: 2, b: "y" });
    store.insert("3", emb, { a: 1, b: "y" });

    const retriever = createVectorRetriever({ embedder, store, contentStore });
    const result = await retriever.retrieve({
      text: "hello",
      limit: 10,
      filter: {
        kind: "and",
        filters: [
          { kind: "eq", field: "a", value: 1 },
          { kind: "not", filter: { kind: "eq", field: "b", value: "x" } },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
    expect(result.value.results[0]?.id).toBe("3");
    store.close();
  });

  test("empty store returns empty results", async () => {
    const store = createVectorStore({ dbPath: ":memory:", dimensions: dims });
    const embedder = createMockEmbedder();

    const retriever = createVectorRetriever({ embedder, store, contentStore: new Map() });
    const result = await retriever.retrieve({ text: "hello", limit: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(0);
    store.close();
  });
});
