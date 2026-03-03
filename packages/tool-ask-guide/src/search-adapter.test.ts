import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { Retriever, SearchPage, SearchResult } from "@koi/search-provider";
import { createRetrieverSearch } from "./search-adapter.js";

/** Creates a mock Retriever that returns fixed results. */
function mockRetriever(results: readonly SearchResult[]): Retriever {
  return {
    retrieve: async (): Promise<Result<SearchPage, KoiError>> => ({
      ok: true,
      value: { results, hasMore: false },
    }),
  };
}

/** Creates a mock Retriever that returns an error. */
function failingRetriever(): Retriever {
  return {
    retrieve: async (): Promise<Result<SearchPage, KoiError>> => ({
      ok: false,
      error: {
        code: "INTERNAL",
        message: "Search index unavailable",
        retryable: true,
      },
    }),
  };
}

describe("createRetrieverSearch", () => {
  test("maps SearchResult to GuideSearchResult", async () => {
    const retriever = mockRetriever([
      {
        id: "doc-1",
        score: 0.95,
        content: "Deploy with `koi deploy --prod`",
        metadata: { title: "Deployment Guide" },
        source: "docs/deploy.md",
      },
      {
        id: "doc-2",
        score: 0.8,
        content: "Rollback with `koi rollback`",
        metadata: { title: "Rollback Procedures" },
        source: "docs/rollback.md",
      },
    ]);

    const search = createRetrieverSearch(retriever);
    const results = await search("deploy", 10);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Deployment Guide",
      content: "Deploy with `koi deploy --prod`",
      source: "docs/deploy.md",
    });
    expect(results[1]).toEqual({
      title: "Rollback Procedures",
      content: "Rollback with `koi rollback`",
      source: "docs/rollback.md",
    });
  });

  test("falls back to id when metadata.title is missing", async () => {
    const retriever = mockRetriever([
      {
        id: "chunk-42",
        score: 0.7,
        content: "Some content",
        metadata: {},
        source: "docs/misc.md",
      },
    ]);

    const search = createRetrieverSearch(retriever);
    const results = await search("query");

    expect(results[0]!.title).toBe("chunk-42");
  });

  test("returns empty array on retriever error", async () => {
    const search = createRetrieverSearch(failingRetriever());
    const results = await search("query");

    expect(results).toEqual([]);
  });

  test("passes maxResults as limit to retriever", async () => {
    let capturedLimit: number | undefined;
    const retriever: Retriever = {
      retrieve: async (query) => {
        capturedLimit = query.limit;
        return { ok: true, value: { results: [], hasMore: false } };
      },
    };

    const search = createRetrieverSearch(retriever);
    await search("query", 5);

    expect(capturedLimit).toBe(5);
  });

  test("defaults maxResults to 10", async () => {
    let capturedLimit: number | undefined;
    const retriever: Retriever = {
      retrieve: async (query) => {
        capturedLimit = query.limit;
        return { ok: true, value: { results: [], hasMore: false } };
      },
    };

    const search = createRetrieverSearch(retriever);
    await search("query");

    expect(capturedLimit).toBe(10);
  });
});
