import { describe, expect, test } from "bun:test";
import { createBm25Index, defaultTokenize } from "./bm25-index.js";
import { createBm25Retriever } from "./bm25-retriever.js";

function buildRetriever(
  docs: readonly { id: string; content: string; metadata?: Record<string, unknown> }[],
) {
  let index = createBm25Index();
  const documents = new Map<
    string,
    { id: string; content: string; metadata: Record<string, unknown> }
  >();

  for (const doc of docs) {
    const tokens = defaultTokenize(doc.content);
    index = index.add(doc.id, tokens);
    documents.set(doc.id, { id: doc.id, content: doc.content, metadata: doc.metadata ?? {} });
  }

  return createBm25Retriever({ index, documents });
}

describe("BM25 Retriever", () => {
  test("retrieve returns ok with matching results", async () => {
    const retriever = buildRetriever([
      { id: "1", content: "hello world" },
      { id: "2", content: "goodbye world" },
    ]);

    const result = await retriever.retrieve({ text: "hello", limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
    expect(result.value.results[0]?.id).toBe("1");
    expect(result.value.results[0]?.source).toBe("bm25");
  });

  test("empty query returns empty results", async () => {
    const retriever = buildRetriever([{ id: "1", content: "hello" }]);
    const result = await retriever.retrieve({ text: "   ", limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(0);
  });

  test("limit is respected", async () => {
    const retriever = buildRetriever(
      Array.from({ length: 10 }, (_, i) => ({ id: String(i), content: `match word${i}` })),
    );
    const result = await retriever.retrieve({ text: "match", limit: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(3);
    expect(result.value.hasMore).toBe(true);
  });

  test("offset paginates correctly", async () => {
    const retriever = buildRetriever(
      Array.from({ length: 5 }, (_, i) => ({ id: String(i), content: `match item${i}` })),
    );
    const page1 = await retriever.retrieve({ text: "match", limit: 2, offset: 0 });
    const page2 = await retriever.retrieve({ text: "match", limit: 2, offset: 2 });
    expect(page1.ok).toBe(true);
    expect(page2.ok).toBe(true);
    if (!page1.ok || !page2.ok) return;
    expect(page1.value.results[0]?.id).not.toBe(page2.value.results[0]?.id);
  });

  test("minScore filters low-scoring results", async () => {
    const retriever = buildRetriever([
      { id: "1", content: "hello hello hello" },
      { id: "2", content: "hello world other words" },
    ]);
    const result = await retriever.retrieve({ text: "hello", limit: 10, minScore: 999 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(0);
  });

  test("filter eq on metadata", async () => {
    const retriever = buildRetriever([
      { id: "1", content: "hello world", metadata: { category: "a" } },
      { id: "2", content: "hello there", metadata: { category: "b" } },
    ]);
    const result = await retriever.retrieve({
      text: "hello",
      limit: 10,
      filter: { kind: "eq", field: "category", value: "a" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
    expect(result.value.results[0]?.id).toBe("1");
  });

  test("filter ne excludes matching value", async () => {
    const retriever = buildRetriever([
      { id: "1", content: "hello world", metadata: { category: "a" } },
      { id: "2", content: "hello there", metadata: { category: "b" } },
    ]);
    const result = await retriever.retrieve({
      text: "hello",
      limit: 10,
      filter: { kind: "ne", field: "category", value: "a" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
    expect(result.value.results[0]?.id).toBe("2");
  });

  test("filter gt/lt on numeric metadata", async () => {
    const retriever = buildRetriever([
      { id: "1", content: "hello", metadata: { score: 10 } },
      { id: "2", content: "hello", metadata: { score: 50 } },
      { id: "3", content: "hello", metadata: { score: 90 } },
    ]);
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
  });

  test("filter in matches any of the values", async () => {
    const retriever = buildRetriever([
      { id: "1", content: "hello", metadata: { tag: "a" } },
      { id: "2", content: "hello", metadata: { tag: "b" } },
      { id: "3", content: "hello", metadata: { tag: "c" } },
    ]);
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
  });

  test("filter or matches either condition", async () => {
    const retriever = buildRetriever([
      { id: "1", content: "hello", metadata: { a: 1 } },
      { id: "2", content: "hello", metadata: { a: 2 } },
      { id: "3", content: "hello", metadata: { a: 3 } },
    ]);
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
  });

  test("filter and/or/not composable", async () => {
    const retriever = buildRetriever([
      { id: "1", content: "hello", metadata: { a: 1, b: "x" } },
      { id: "2", content: "hello", metadata: { a: 2, b: "y" } },
      { id: "3", content: "hello", metadata: { a: 1, b: "y" } },
    ]);
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
  });
});
