import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { WebExecutor, WebSearchResult } from "./web-executor.js";
import { createWebSearchTool } from "./web-search-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockExecutor(searchResponse: Result<readonly WebSearchResult[], KoiError>): WebExecutor {
  return {
    fetch: async () => ({
      ok: false,
      error: { code: "VALIDATION", message: "Not implemented", retryable: false },
    }),
    search: async () => searchResponse,
  };
}

const SAMPLE_RESULTS: readonly WebSearchResult[] = [
  { title: "Result 1", url: "https://example.com/1", snippet: "First result" },
  { title: "Result 2", url: "https://example.com/2", snippet: "Second result" },
  { title: "Result 3", url: "https://example.com/3", snippet: "Third result" },
  { title: "Result 4", url: "https://example.com/4", snippet: "Fourth result" },
  { title: "Result 5", url: "https://example.com/5", snippet: "Fifth result" },
  { title: "Result 6", url: "https://example.com/6", snippet: "Sixth result" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWebSearchTool", () => {
  describe("descriptor", () => {
    test("has correct name with prefix", () => {
      const tool = createWebSearchTool(
        mockExecutor({ ok: true, value: [] }),
        "web",
        DEFAULT_UNSANDBOXED_POLICY,
      );
      expect(tool.descriptor.name).toBe("web_search");
    });

    test("uses custom prefix", () => {
      const tool = createWebSearchTool(
        mockExecutor({ ok: true, value: [] }),
        "custom",
        DEFAULT_SANDBOXED_POLICY,
      );
      expect(tool.descriptor.name).toBe("custom_search");
    });
  });

  describe("validation", () => {
    const tool = createWebSearchTool(
      mockExecutor({ ok: true, value: SAMPLE_RESULTS }),
      "web",
      DEFAULT_UNSANDBOXED_POLICY,
    );

    test("rejects missing query", async () => {
      const result = (await tool.execute({})) as { error: string; code: string };
      expect(result.code).toBe("VALIDATION");
      expect(result.error).toContain("query");
    });

    test("rejects empty query", async () => {
      const result = (await tool.execute({ query: "" })) as { error: string; code: string };
      expect(result.code).toBe("VALIDATION");
    });

    test("rejects whitespace-only query", async () => {
      const result = (await tool.execute({ query: "   " })) as { error: string; code: string };
      expect(result.code).toBe("VALIDATION");
    });
  });

  describe("results", () => {
    test("returns search results", async () => {
      const tool = createWebSearchTool(
        mockExecutor({ ok: true, value: SAMPLE_RESULTS }),
        "web",
        DEFAULT_UNSANDBOXED_POLICY,
      );
      const result = (await tool.execute({ query: "test" })) as {
        query: string;
        results: readonly WebSearchResult[];
        count: number;
      };
      expect(result.query).toBe("test");
      expect(result.results.length).toBe(5); // default max_results = 5
      expect(result.count).toBe(5);
    });

    test("respects max_results", async () => {
      const tool = createWebSearchTool(
        mockExecutor({ ok: true, value: SAMPLE_RESULTS }),
        "web",
        DEFAULT_UNSANDBOXED_POLICY,
      );
      const result = (await tool.execute({ query: "test", max_results: 2 })) as {
        results: readonly WebSearchResult[];
        count: number;
      };
      expect(result.results.length).toBe(2);
      expect(result.count).toBe(2);
    });

    test("clamps max_results to valid range", async () => {
      const tool = createWebSearchTool(
        mockExecutor({ ok: true, value: SAMPLE_RESULTS }),
        "web",
        DEFAULT_UNSANDBOXED_POLICY,
      );
      // Below minimum (1)
      const low = (await tool.execute({ query: "test", max_results: 0 })) as {
        results: readonly WebSearchResult[];
        count: number;
      };
      expect(low.count).toBe(1);

      // Above maximum (20)
      const high = (await tool.execute({ query: "test", max_results: 100 })) as {
        results: readonly WebSearchResult[];
        count: number;
      };
      expect(high.count).toBe(SAMPLE_RESULTS.length);
    });

    test("trims whitespace from query", async () => {
      let capturedQuery: string | undefined;
      const executor: WebExecutor = {
        fetch: async () => ({
          ok: false,
          error: { code: "VALIDATION", message: "Not implemented", retryable: false },
        }),
        search: async (query) => {
          capturedQuery = query;
          return { ok: true, value: SAMPLE_RESULTS };
        },
      };
      const tool = createWebSearchTool(executor, "web", DEFAULT_UNSANDBOXED_POLICY);
      const result = (await tool.execute({ query: "  hello world  " })) as { query: string };
      expect(result.query).toBe("hello world");
      expect(capturedQuery).toBe("hello world");
    });
  });

  describe("error handling", () => {
    test("propagates executor errors", async () => {
      const executor = mockExecutor({
        ok: false,
        error: { code: "EXTERNAL", message: "Search backend unavailable", retryable: true },
      });
      const tool = createWebSearchTool(executor, "web", DEFAULT_UNSANDBOXED_POLICY);
      const result = (await tool.execute({ query: "test" })) as { error: string; code: string };
      expect(result.code).toBe("EXTERNAL");
      expect(result.error).toBe("Search backend unavailable");
    });
  });

  describe("provider provenance (#1464)", () => {
    test("includes provider name in output when available", async () => {
      const executor: WebExecutor = {
        providerName: "brave",
        fetch: async () => ({
          ok: false,
          error: { code: "VALIDATION", message: "Not implemented", retryable: false },
        }),
        search: async () => ({ ok: true, value: SAMPLE_RESULTS }),
      };
      const tool = createWebSearchTool(executor, "web", DEFAULT_UNSANDBOXED_POLICY);
      const result = (await tool.execute({ query: "test" })) as {
        provider: string;
        query: string;
      };
      expect(result.provider).toBe("brave");
      expect(result.query).toBe("test");
    });

    test("defaults provider to unknown when not set", async () => {
      const tool = createWebSearchTool(
        mockExecutor({ ok: true, value: SAMPLE_RESULTS }),
        "web",
        DEFAULT_UNSANDBOXED_POLICY,
      );
      const result = (await tool.execute({ query: "test" })) as { provider: string };
      expect(result.provider).toBe("unknown");
    });

    test("sets descriptor.server to provider name for provenance tracking", () => {
      const executor: WebExecutor = {
        providerName: "tavily",
        fetch: async () => ({
          ok: false,
          error: { code: "VALIDATION", message: "Not implemented", retryable: false },
        }),
        search: async () => ({ ok: true, value: [] }),
      };
      const tool = createWebSearchTool(executor, "web", DEFAULT_UNSANDBOXED_POLICY);
      expect(tool.descriptor.server).toBe("tavily");
    });

    test("does not set descriptor.server when provider name is absent", () => {
      const tool = createWebSearchTool(
        mockExecutor({ ok: true, value: [] }),
        "web",
        DEFAULT_UNSANDBOXED_POLICY,
      );
      expect(tool.descriptor.server).toBeUndefined();
    });
  });
});
