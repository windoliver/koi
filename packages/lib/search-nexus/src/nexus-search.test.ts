import { beforeEach, describe, expect, test } from "bun:test";
import { createNexusSearch } from "./nexus-search.js";
import { createMockTransport, type MockTransport } from "./test-helpers.js";

describe("createNexusSearch", () => {
  let transport: MockTransport;

  beforeEach(() => {
    transport = createMockTransport();
  });

  test("rejects invalid config", () => {
    expect(() => createNexusSearch({ transport, indexName: "" })).toThrow(/indexName/);
  });

  test("retrieve calls search_retrieve with indexName + text + limit", async () => {
    transport.stub("search_retrieve", async () => ({
      ok: true,
      value: { hits: [], total: 0 },
    }));

    const search = createNexusSearch({ transport, indexName: "test-idx" });
    const result = await search.retrieve({ text: "hello", limit: 10 });

    expect(result.ok).toBe(true);
    expect(transport.calls.length).toBe(1);
    const params = transport.calls[0]?.params;
    expect(params?.index).toBe("test-idx");
    expect(params?.text).toBe("hello");
    expect(params?.limit).toBe(10);
  });

  test("retrieve maps Nexus hits to SearchResult shape", async () => {
    transport.stub("search_retrieve", async () => ({
      ok: true,
      value: {
        hits: [
          {
            id: "doc-1",
            score: 0.9,
            content: "hello world",
            metadata: { tag: "ops" },
          },
        ],
        total: 1,
      },
    }));

    const search = createNexusSearch({ transport });
    const result = await search.retrieve({ text: "hello", limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results.length).toBe(1);
      const first = result.value.results[0];
      expect(first?.id).toBe("doc-1");
      expect(first?.score).toBe(0.9);
      expect(first?.metadata).toEqual({ tag: "ops" });
      expect(first?.source).toBe("koi");
      expect(result.value.total).toBe(1);
      expect(result.value.hasMore).toBe(false);
    }
  });

  test("retrieve sets hasMore=true when cursor present", async () => {
    transport.stub("search_retrieve", async () => ({
      ok: true,
      value: { hits: [], cursor: "next-page" },
    }));

    const search = createNexusSearch({ transport });
    const result = await search.retrieve({ text: "x", limit: 1 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hasMore).toBe(true);
      expect(result.value.cursor).toBe("next-page");
    }
  });

  test("retrieve filters by minScore client-side", async () => {
    transport.stub("search_retrieve", async () => ({
      ok: true,
      value: {
        hits: [
          { id: "a", score: 0.9, content: "x" },
          { id: "b", score: 0.4, content: "x" },
          { id: "c", score: 0.6, content: "x" },
        ],
      },
    }));

    const search = createNexusSearch({ transport });
    const result = await search.retrieve({ text: "x", limit: 10, minScore: 0.5 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results.map((r) => r.id)).toEqual(["a", "c"]);
    }
  });

  test("retrieve propagates transport error", async () => {
    transport.stub("search_retrieve", async () => ({
      ok: false,
      error: { code: "EXTERNAL", message: "down", retryable: true },
    }));

    const search = createNexusSearch({ transport });
    const result = await search.retrieve({ text: "x", limit: 10 });
    expect(result.ok).toBe(false);
  });

  test("index with empty array is a no-op", async () => {
    const search = createNexusSearch({ transport });
    const result = await search.index([]);
    expect(result.ok).toBe(true);
    expect(transport.calls.length).toBe(0);
  });

  test("index batches documents according to maxBatchSize", async () => {
    transport.stub("search_index", async () => ({ ok: true, value: undefined }));

    const search = createNexusSearch({ transport, maxBatchSize: 2 });
    const docs = [
      { id: "1", content: "a" },
      { id: "2", content: "b" },
      { id: "3", content: "c" },
    ];
    const result = await search.index(docs);

    expect(result.ok).toBe(true);
    expect(transport.calls.length).toBe(2);
    expect((transport.calls[0]?.params.documents as readonly unknown[]).length).toBe(2);
    expect((transport.calls[1]?.params.documents as readonly unknown[]).length).toBe(1);
  });

  test("index propagates first-batch error and stops", async () => {
    let calls = 0;
    transport.stub("search_index", async () => {
      calls++;
      return {
        ok: false,
        error: { code: "EXTERNAL", message: "fail", retryable: true },
      };
    });

    const search = createNexusSearch({ transport, maxBatchSize: 1 });
    const result = await search.index([
      { id: "1", content: "a" },
      { id: "2", content: "b" },
    ]);

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  test("index error context records partial-progress on mid-batch failure", async () => {
    let calls = 0;
    transport.stub("search_index", async () => {
      calls++;
      if (calls === 1) return { ok: true, value: undefined };
      return {
        ok: false,
        error: { code: "EXTERNAL", message: "second batch failed", retryable: true },
      };
    });

    const search = createNexusSearch({ transport, maxBatchSize: 2 });
    const result = await search.index([
      { id: "1", content: "a" },
      { id: "2", content: "b" },
      { id: "3", content: "c" },
      { id: "4", content: "d" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.committedCount).toBe(2);
      expect(result.error.context?.failedBatchStart).toBe(2);
      expect(result.error.context?.failedBatchEnd).toBe(4);
      expect(result.error.context?.totalCount).toBe(4);
      expect(result.error.context?.retryHint).toContain("idempotent");
    }
  });

  test("remove with empty array is a no-op", async () => {
    const search = createNexusSearch({ transport });
    const result = await search.remove([]);
    expect(result.ok).toBe(true);
    expect(transport.calls.length).toBe(0);
  });

  test("remove sends ids to search_remove", async () => {
    transport.stub("search_remove", async () => ({ ok: true, value: undefined }));

    const search = createNexusSearch({ transport, indexName: "idx" });
    const result = await search.remove(["a", "b"]);

    expect(result.ok).toBe(true);
    expect(transport.calls[0]?.method).toBe("search_remove");
    expect(transport.calls[0]?.params.ids).toEqual(["a", "b"]);
    expect(transport.calls[0]?.params.index).toBe("idx");
  });
});
