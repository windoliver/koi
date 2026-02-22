import { describe, expect, test } from "bun:test";
import type { Retriever } from "../contracts.js";
import type { SearchOutcome, SearchPage, SearchQuery, SearchResult } from "../types.js";
import { createHybridRetriever } from "./hybrid-retriever.js";

function makeResult(id: string, score: number, source: string): SearchResult {
  return { id, score, content: `content-${id}`, metadata: {}, source };
}

function mockRetriever(results: readonly SearchResult[]): Retriever {
  return {
    retrieve: async (query: SearchQuery): Promise<SearchOutcome<SearchPage>> => ({
      ok: true,
      value: {
        results: results.slice(0, query.limit),
        total: results.length,
        hasMore: results.length > query.limit,
      },
    }),
  };
}

function failingRetriever(): Retriever {
  return {
    retrieve: async (): Promise<SearchOutcome<SearchPage>> => ({
      ok: false,
      error: { kind: "backend_unavailable", backend: "test" },
    }),
  };
}

function slowRetriever(ms: number): Retriever {
  return {
    retrieve: () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: true,
              value: { results: [makeResult("slow", 0.5, "slow")], hasMore: false },
            }),
          ms,
        ),
      ),
  };
}

describe("HybridRetriever", () => {
  test("combines results from multiple retrievers", async () => {
    const r1 = mockRetriever([makeResult("a", 0.9, "bm25"), makeResult("b", 0.7, "bm25")]);
    const r2 = mockRetriever([makeResult("b", 0.8, "vec"), makeResult("c", 0.6, "vec")]);

    const hybrid = createHybridRetriever({
      retrievers: [r1, r2],
      fusion: { kind: "rrf" },
    });

    const result = await hybrid.retrieve({ text: "test", limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.results.map((r) => r.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
  });

  test("graceful degradation — one retriever fails", async () => {
    const r1 = mockRetriever([makeResult("a", 0.9, "bm25")]);
    const r2 = failingRetriever();

    const hybrid = createHybridRetriever({
      retrievers: [r1, r2],
      fusion: { kind: "rrf" },
    });

    const result = await hybrid.retrieve({ text: "test", limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
    expect(result.value.results[0]?.id).toBe("a");
  });

  test("all retrievers fail — returns error", async () => {
    const hybrid = createHybridRetriever({
      retrievers: [failingRetriever(), failingRetriever()],
      fusion: { kind: "rrf" },
    });

    const result = await hybrid.retrieve({ text: "test", limit: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("backend_unavailable");
  });

  test("timeout — slow retriever is dropped", async () => {
    const fast = mockRetriever([makeResult("fast", 0.9, "fast")]);
    const slow = slowRetriever(5000);

    const hybrid = createHybridRetriever({
      retrievers: [fast, slow],
      fusion: { kind: "rrf" },
      timeoutMs: 50,
    });

    const result = await hybrid.retrieve({ text: "test", limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
    expect(result.value.results[0]?.id).toBe("fast");
  });

  test("limit is respected after fusion", async () => {
    const r1 = mockRetriever(
      Array.from({ length: 10 }, (_, i) => makeResult(`a${i}`, 0.9 - i * 0.1, "s1")),
    );

    const hybrid = createHybridRetriever({
      retrievers: [r1],
      fusion: { kind: "rrf" },
    });

    const result = await hybrid.retrieve({ text: "test", limit: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(3);
    expect(result.value.hasMore).toBe(true);
  });

  test("offset paginates after fusion", async () => {
    const r1 = mockRetriever(
      Array.from({ length: 10 }, (_, i) => makeResult(`a${i}`, 0.9 - i * 0.01, "s1")),
    );

    const hybrid = createHybridRetriever({
      retrievers: [r1],
      fusion: { kind: "rrf" },
    });

    const page1 = await hybrid.retrieve({ text: "test", limit: 2, offset: 0 });
    const page2 = await hybrid.retrieve({ text: "test", limit: 2, offset: 2 });

    expect(page1.ok).toBe(true);
    expect(page2.ok).toBe(true);
    if (!page1.ok || !page2.ok) return;
    expect(page1.value.results[0]?.id).not.toBe(page2.value.results[0]?.id);
  });

  test("minScore filters after fusion", async () => {
    const r1 = mockRetriever([makeResult("a", 0.9, "s1")]);

    const hybrid = createHybridRetriever({
      retrievers: [r1],
      fusion: { kind: "rrf" },
    });

    // RRF score for single item: 1/61 ≈ 0.016
    const result = await hybrid.retrieve({ text: "test", limit: 10, minScore: 0.5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(0);
  });

  test("single retriever — passthrough via fusion", async () => {
    const r = mockRetriever([makeResult("a", 0.9, "s1")]);
    const hybrid = createHybridRetriever({
      retrievers: [r],
      fusion: { kind: "rrf" },
    });

    const result = await hybrid.retrieve({ text: "test", limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
  });
});
