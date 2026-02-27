import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@koi/core";
import type { WebExecutor, WebSearchResult } from "../web-executor.js";
import { createWebSearchTool } from "./web-search.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockExecutor(results: readonly WebSearchResult[]): WebExecutor {
  return {
    fetch: async () => ({
      ok: true,
      value: {
        status: 200,
        statusText: "OK",
        headers: {},
        body: "",
        truncated: false,
        finalUrl: "",
      },
    }),
    search: async () => ({ ok: true, value: results }),
  };
}

function execute(executor: WebExecutor, args: JsonObject): Promise<unknown> {
  const tool = createWebSearchTool(executor, "web", "verified");
  return tool.execute(args);
}

const SAMPLE_RESULTS: readonly WebSearchResult[] = [
  { title: "Result 1", url: "https://example.com/1", snippet: "First result" },
  { title: "Result 2", url: "https://example.com/2", snippet: "Second result" },
  { title: "Result 3", url: "https://example.com/3", snippet: "Third result" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("web_search", () => {
  test("descriptor has correct name and schema", () => {
    const executor = mockExecutor([]);
    const tool = createWebSearchTool(executor, "web", "verified");
    expect(tool.descriptor.name).toBe("web_search");
    expect(tool.trustTier).toBe("verified");
  });

  test("respects custom prefix", () => {
    const executor = mockExecutor([]);
    const tool = createWebSearchTool(executor, "agent", "sandbox");
    expect(tool.descriptor.name).toBe("agent_search");
  });

  test("returns validation error for missing query", async () => {
    const executor = mockExecutor([]);
    const result = (await execute(executor, {})) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("query");
  });

  test("returns validation error for empty query", async () => {
    const executor = mockExecutor([]);
    const result = (await execute(executor, { query: "   " })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns search results", async () => {
    const executor = mockExecutor(SAMPLE_RESULTS);
    const result = (await execute(executor, { query: "test query" })) as Record<string, unknown>;
    expect(result.query).toBe("test query");
    expect(result.count).toBe(3);
    expect(result.results).toHaveLength(3);
  });

  test("respects max_results", async () => {
    const executor = mockExecutor(SAMPLE_RESULTS);
    const result = (await execute(executor, { query: "test", max_results: 2 })) as Record<
      string,
      unknown
    >;
    expect(result.count).toBe(2);
    expect(result.results).toHaveLength(2);
  });

  test("clamps max_results to allowed range", async () => {
    const executor = mockExecutor(SAMPLE_RESULTS);
    // max_results: 0 should be clamped to 1
    const result = (await execute(executor, { query: "test", max_results: 0 })) as Record<
      string,
      unknown
    >;
    expect(result.count).toBe(1);
  });

  test("trims query whitespace", async () => {
    let capturedQuery = "";
    const executor: WebExecutor = {
      fetch: async () => ({
        ok: true,
        value: {
          status: 200,
          statusText: "OK",
          headers: {},
          body: "",
          truncated: false,
          finalUrl: "",
        },
      }),
      search: async (query) => {
        capturedQuery = query;
        return { ok: true, value: [] };
      },
    };
    await execute(executor, { query: "  hello world  " });
    expect(capturedQuery).toBe("hello world");
  });

  test("returns error from executor failure", async () => {
    const executor: WebExecutor = {
      fetch: async () => ({
        ok: true,
        value: {
          status: 200,
          statusText: "OK",
          headers: {},
          body: "",
          truncated: false,
          finalUrl: "",
        },
      }),
      search: async () => ({
        ok: false,
        error: { code: "VALIDATION", message: "No search backend", retryable: false },
      }),
    };
    const result = (await execute(executor, { query: "test" })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });
});
