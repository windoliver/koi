import { describe, expect, test } from "bun:test";
import type { Embedder } from "../contracts.js";
import { createSearch } from "../index.js";

const dims = 32;

/**
 * Mock embedder that produces deterministic embeddings based on text content.
 * Words that share characters produce more similar embeddings.
 */
function createMockEmbedder(): Embedder {
  function textToEmbedding(text: string): readonly number[] {
    const vec = new Array(dims).fill(0) as number[];
    const lower = text.toLowerCase();
    for (let i = 0; i < lower.length; i++) {
      const code = lower.charCodeAt(i);
      const idx = code % dims;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    // L2 normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] = (vec[i] ?? 0) / norm;
      }
    }
    return vec;
  }

  return {
    embed: async (text: string) => textToEmbedding(text),
    embedMany: async (texts: readonly string[]) => texts.map(textToEmbedding),
    dimensions: dims,
  };
}

describe("E2E: createSearch full pipeline", () => {
  const documents = [
    {
      id: "doc1",
      content: "TypeScript is a typed superset of JavaScript",
      metadata: { lang: "en", topic: "programming" },
    },
    {
      id: "doc2",
      content: "Python is great for data science and machine learning",
      metadata: { lang: "en", topic: "programming" },
    },
    {
      id: "doc3",
      content: "The quick brown fox jumps over the lazy dog",
      metadata: { lang: "en", topic: "pangram" },
    },
    {
      id: "doc4",
      content: "Bun is a fast JavaScript runtime written in Zig",
      metadata: { lang: "en", topic: "programming" },
    },
    {
      id: "doc5",
      content: "Rust provides memory safety without garbage collection",
      metadata: { lang: "en", topic: "programming" },
    },
  ] as const;

  test("index → BM25 search returns keyword matches", async () => {
    const search = createSearch({ embedder: createMockEmbedder() });

    // Index all documents
    const indexResult = await search.indexer.index(documents);
    expect(indexResult.ok).toBe(true);

    // BM25 search for "JavaScript"
    const result = await search.bm25.retrieve({ text: "JavaScript", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should find doc1 (TypeScript/JavaScript) and doc4 (Bun/JavaScript)
    const ids = result.value.results.map((r) => r.id);
    expect(ids).toContain("doc1");
    expect(ids).toContain("doc4");
    expect(result.value.results[0]?.source).toBe("bm25");

    search.close();
  });

  test("index → vector search returns semantically similar results", async () => {
    const search = createSearch({ embedder: createMockEmbedder() });
    await search.indexer.index(documents);

    // Vector search
    const result = await search.vector.retrieve({ text: "programming language", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.results.length).toBeGreaterThan(0);
    expect(result.value.results[0]?.source).toBe("vector");

    search.close();
  });

  test("index → hybrid search fuses BM25 + vector results", async () => {
    const search = createSearch({ embedder: createMockEmbedder() });
    await search.indexer.index(documents);

    // Hybrid search (default RRF fusion)
    const result = await search.retriever.retrieve({ text: "JavaScript runtime", limit: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.results.length).toBeGreaterThan(0);
    expect(result.value.results.length).toBeLessThanOrEqual(3);

    // Results should have fused scores
    for (const r of result.value.results) {
      expect(r.score).toBeGreaterThan(0);
    }

    search.close();
  });

  test("index → remove → search no longer returns removed docs", async () => {
    const search = createSearch({ embedder: createMockEmbedder() });
    await search.indexer.index(documents);

    // Verify doc1 is found
    const before = await search.bm25.retrieve({ text: "TypeScript", limit: 5 });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.results.map((r) => r.id)).toContain("doc1");

    // Remove doc1
    const removeResult = await search.indexer.remove(["doc1"]);
    expect(removeResult.ok).toBe(true);

    // Verify doc1 is no longer found
    const after = await search.bm25.retrieve({ text: "TypeScript", limit: 5 });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.results.map((r) => r.id)).not.toContain("doc1");

    search.close();
  });

  test("filter narrows results by metadata", async () => {
    const search = createSearch({ embedder: createMockEmbedder() });
    await search.indexer.index(documents);

    // Search with filter: only "pangram" topic
    const result = await search.bm25.retrieve({
      text: "the",
      limit: 5,
      filter: { kind: "eq", field: "topic", value: "pangram" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const r of result.value.results) {
      expect(r.metadata.topic).toBe("pangram");
    }

    search.close();
  });

  test("pagination works across retrievers", async () => {
    const search = createSearch({ embedder: createMockEmbedder() });
    await search.indexer.index(documents);

    // Page 1
    const page1 = await search.bm25.retrieve({ text: "is", limit: 2, offset: 0 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.results).toHaveLength(2);
    expect(page1.value.hasMore).toBe(true);

    // Page 2
    const page2 = await search.bm25.retrieve({ text: "is", limit: 2, offset: 2 });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;

    // Pages should have different results
    const page1Ids = new Set(page1.value.results.map((r) => r.id));
    for (const r of page2.value.results) {
      expect(page1Ids.has(r.id)).toBe(false);
    }

    search.close();
  });

  test("custom fusion strategy works", async () => {
    const search = createSearch({
      embedder: createMockEmbedder(),
      fusion: { kind: "weighted_rrf", k: 60, weights: [0.7, 0.3] },
    });
    await search.indexer.index(documents);

    const result = await search.retriever.retrieve({ text: "JavaScript", limit: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBeGreaterThan(0);

    search.close();
  });

  test("empty search returns empty results", async () => {
    const search = createSearch({ embedder: createMockEmbedder() });
    await search.indexer.index(documents);

    const result = await search.bm25.retrieve({ text: "   ", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(0);

    search.close();
  });

  test("search with no indexed documents returns empty", async () => {
    const search = createSearch({ embedder: createMockEmbedder() });

    const result = await search.bm25.retrieve({ text: "hello", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(0);

    search.close();
  });

  test("embed is called once per document during indexing, not twice", async () => {
    let embedCallCount = 0;
    const base = createMockEmbedder();
    const countingEmbedder: Embedder = {
      dimensions: base.dimensions,
      embed: async (text: string) => {
        embedCallCount++;
        return base.embed(text);
      },
      embedMany: async (texts: readonly string[]) => {
        embedCallCount += texts.length;
        return base.embedMany(texts);
      },
    };

    const search = createSearch({ embedder: countingEmbedder });
    const docs = [
      { id: "a", content: "alpha document" },
      { id: "b", content: "beta document" },
      { id: "c", content: "gamma document" },
    ] as const;

    embedCallCount = 0;
    await search.indexer.index(docs);

    // Each doc should be embedded exactly once (3 docs = 3 embeds from the
    // index wrapper). The sqlite-indexer receives enriched docs with
    // pre-computed embeddings so it should not re-embed single-chunk docs.
    expect(embedCallCount).toBe(3);

    search.close();
  });
});
