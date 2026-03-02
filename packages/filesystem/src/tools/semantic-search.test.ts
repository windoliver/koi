import { describe, expect, mock, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { Retriever, SearchPage } from "@koi/search-provider";
import { createFsSemanticSearchTool, DEFAULT_SEMANTIC_SEARCH_LIMIT } from "./semantic-search.js";

function createMockRetriever(
  response: Result<SearchPage, KoiError>,
): Retriever & { readonly retrieve: ReturnType<typeof mock> } {
  return { retrieve: mock(() => Promise.resolve(response)) };
}

const SUCCESS_PAGE: SearchPage = {
  results: [
    {
      id: "1",
      score: 0.95,
      content: "authentication logic",
      metadata: {},
      source: "/src/auth.ts",
    },
  ],
  hasMore: false,
};

describe("createFsSemanticSearchTool", () => {
  test("descriptor has correct name and schema", () => {
    const retriever = createMockRetriever({ ok: true, value: SUCCESS_PAGE });
    const tool = createFsSemanticSearchTool(retriever, "fs", "verified");

    expect(tool.descriptor.name).toBe("fs_semantic_search");
    expect(tool.descriptor.inputSchema).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        limit: {
          type: "number",
          description: `Maximum number of results to return (default: ${DEFAULT_SEMANTIC_SEARCH_LIMIT})`,
        },
        minScore: {
          type: "number",
          description: "Minimum relevance score threshold (0–1)",
        },
      },
      required: ["query"],
    });
  });

  test("returns mapped results on success", async () => {
    const retriever = createMockRetriever({ ok: true, value: SUCCESS_PAGE });
    const tool = createFsSemanticSearchTool(retriever, "fs", "verified");

    const result = await tool.execute({ query: "authentication" });
    expect(result).toEqual(SUCCESS_PAGE);
  });

  test("passes default limit to retriever", async () => {
    const retriever = createMockRetriever({ ok: true, value: SUCCESS_PAGE });
    const tool = createFsSemanticSearchTool(retriever, "fs", "verified");

    await tool.execute({ query: "auth" });
    expect(retriever.retrieve).toHaveBeenCalledWith({
      text: "auth",
      limit: DEFAULT_SEMANTIC_SEARCH_LIMIT,
    });
  });

  test("passes explicit limit to retriever", async () => {
    const retriever = createMockRetriever({ ok: true, value: SUCCESS_PAGE });
    const tool = createFsSemanticSearchTool(retriever, "fs", "verified");

    await tool.execute({ query: "auth", limit: 5 });
    expect(retriever.retrieve).toHaveBeenCalledWith({
      text: "auth",
      limit: 5,
    });
  });

  test("passes minScore to retriever", async () => {
    const retriever = createMockRetriever({ ok: true, value: SUCCESS_PAGE });
    const tool = createFsSemanticSearchTool(retriever, "fs", "verified");

    await tool.execute({ query: "auth", minScore: 0.8 });
    expect(retriever.retrieve).toHaveBeenCalledWith({
      text: "auth",
      limit: DEFAULT_SEMANTIC_SEARCH_LIMIT,
      minScore: 0.8,
    });
  });

  test("returns error on retriever failure", async () => {
    const error: KoiError = {
      code: "INTERNAL",
      message: "index unavailable",
      retryable: false,
    };
    const retriever = createMockRetriever({ ok: false, error });
    const tool = createFsSemanticSearchTool(retriever, "fs", "verified");

    const result = await tool.execute({ query: "auth" });
    expect(result).toEqual({ error: "index unavailable", code: "INTERNAL" });
  });

  test("returns validation error when query missing", async () => {
    const retriever = createMockRetriever({ ok: true, value: SUCCESS_PAGE });
    const tool = createFsSemanticSearchTool(retriever, "fs", "verified");

    const result = await tool.execute({});
    expect(result).toEqual({ error: "query must be a non-empty string", code: "VALIDATION" });
  });

  test("returns validation error when query not string", async () => {
    const retriever = createMockRetriever({ ok: true, value: SUCCESS_PAGE });
    const tool = createFsSemanticSearchTool(retriever, "fs", "verified");

    const result = await tool.execute({ query: 42 });
    expect(result).toEqual({ error: "query must be a non-empty string", code: "VALIDATION" });
  });

  test("returns validation error when limit not number", async () => {
    const retriever = createMockRetriever({ ok: true, value: SUCCESS_PAGE });
    const tool = createFsSemanticSearchTool(retriever, "fs", "verified");

    const result = await tool.execute({ query: "auth", limit: "ten" });
    expect(result).toEqual({ error: "limit must be a number", code: "VALIDATION" });
  });

  test("returns validation error when minScore not number", async () => {
    const retriever = createMockRetriever({ ok: true, value: SUCCESS_PAGE });
    const tool = createFsSemanticSearchTool(retriever, "fs", "verified");

    const result = await tool.execute({ query: "auth", minScore: "high" });
    expect(result).toEqual({ error: "minScore must be a number", code: "VALIDATION" });
  });

  test("respects custom prefix", () => {
    const retriever = createMockRetriever({ ok: true, value: SUCCESS_PAGE });
    const tool = createFsSemanticSearchTool(retriever, "cloud", "sandbox");

    expect(tool.descriptor.name).toBe("cloud_semantic_search");
    expect(tool.trustTier).toBe("sandbox");
  });
});
