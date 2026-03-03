import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { SearchPage } from "@koi/search-provider";
import { scanIndex } from "./source-index.js";
import type { IndexSourceConfig } from "./types.js";

function makeRetriever(
  result: Result<SearchPage<unknown>, KoiError>,
): IndexSourceConfig["backend"] {
  return {
    retrieve: async () => result,
  };
}

describe("scanIndex", () => {
  test("transforms retriever results into ParsedDocuments", async () => {
    const backend = makeRetriever({
      ok: true,
      value: {
        results: [
          {
            id: "doc-1",
            score: 0.9,
            content: "Authentication guide content",
            metadata: {
              title: "Auth Guide",
              tags: ["auth", "security"],
              lastModified: 1000,
            },
            source: "test",
          },
          {
            id: "doc-2",
            score: 0.7,
            content: "API reference content",
            metadata: { title: "API Ref" },
            source: "test",
          },
        ],
        hasMore: false,
      },
    });

    const config: IndexSourceConfig = {
      kind: "index",
      name: "test-index",
      backend,
    };

    const result = await scanIndex(config, 100);
    expect(result.documents).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);

    expect(result.documents[0]?.path).toBe("doc-1");
    expect(result.documents[0]?.title).toBe("Auth Guide");
    expect(result.documents[0]?.body).toBe("Authentication guide content");
    expect(result.documents[0]?.tags).toEqual(["auth", "security"]);
    expect(result.documents[0]?.lastModified).toBe(1000);

    expect(result.documents[1]?.title).toBe("API Ref");
    expect(result.documents[1]?.tags).toEqual([]);
  });

  test("returns warning on retriever error", async () => {
    const backend = makeRetriever({
      ok: false,
      error: {
        code: "EXTERNAL",
        message: "Connection refused",
        retryable: false,
      },
    });

    const config: IndexSourceConfig = {
      kind: "index",
      name: "failing-index",
      backend,
    };

    const result = await scanIndex(config, 100);
    expect(result.documents).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Connection refused");
  });

  test("uses id as title fallback when no title in metadata", async () => {
    const backend = makeRetriever({
      ok: true,
      value: {
        results: [
          {
            id: "untitled-doc",
            score: 0.5,
            content: "Some content",
            metadata: {},
            source: "test",
          },
        ],
        hasMore: false,
      },
    });

    const config: IndexSourceConfig = {
      kind: "index",
      backend,
    };

    const result = await scanIndex(config, 100);
    expect(result.documents[0]?.title).toBe("untitled-doc");
  });

  test("handles empty results", async () => {
    const backend = makeRetriever({
      ok: true,
      value: { results: [], hasMore: false },
    });

    const config: IndexSourceConfig = {
      kind: "index",
      backend,
    };

    const result = await scanIndex(config, 100);
    expect(result.documents).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
