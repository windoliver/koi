import { describe, expect, test } from "bun:test";
import { createAskGuideTool } from "./ask-guide-tool.js";
import { createAskGuideProvider } from "./provider.js";
import type { GuideSearchResult } from "./types.js";

/** Creates a search function that returns fixed results. */
function fixedSearch(
  results: readonly GuideSearchResult[],
): (query: string, maxResults?: number) => Promise<readonly GuideSearchResult[]> {
  return async (_query: string, _maxResults?: number) => results;
}

/** Creates a search function that throws. */
function failingSearch(
  error: Error,
): (query: string, maxResults?: number) => Promise<readonly GuideSearchResult[]> {
  return async () => {
    throw error;
  };
}

describe("createAskGuideTool", () => {
  // -------------------------------------------------------------------------
  // Descriptor
  // -------------------------------------------------------------------------

  test("descriptor has correct name and schema", () => {
    const tool = createAskGuideTool({ search: fixedSearch([]) });
    expect(tool.descriptor.name).toBe("ask_guide");
    expect(tool.descriptor.inputSchema).toBeDefined();
    expect(tool.descriptor.inputSchema.required).toContain("question");
  });

  test("policy is verified", () => {
    const tool = createAskGuideTool({ search: fixedSearch([]) });
    expect(tool.policy.sandbox).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  test("returns results for valid question", async () => {
    const results: readonly GuideSearchResult[] = [
      { title: "Getting Started", content: "Install with bun add koi", source: "docs/start.md" },
      { title: "Configuration", content: "Edit koi.yaml", source: "docs/config.md" },
    ];
    const tool = createAskGuideTool({ search: fixedSearch(results), maxTokens: 1000 });
    const output = (await tool.execute({ question: "How do I install?" })) as {
      results: readonly GuideSearchResult[];
      totalFound: number;
      truncated: boolean;
    };

    expect(output.results).toHaveLength(2);
    expect(output.totalFound).toBe(2);
    expect(output.truncated).toBe(false);
    expect(output.results[0]?.title).toBe("Getting Started");
  });

  test("returns empty results when search finds nothing", async () => {
    const tool = createAskGuideTool({ search: fixedSearch([]) });
    const output = (await tool.execute({ question: "obscure query" })) as {
      results: readonly GuideSearchResult[];
      totalFound: number;
      truncated: boolean;
    };

    expect(output.results).toHaveLength(0);
    expect(output.totalFound).toBe(0);
    expect(output.truncated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Token budget
  // -------------------------------------------------------------------------

  test("truncates results when exceeding maxTokens budget", async () => {
    // Each result ~50 chars = ~13 tokens. With maxTokens=15, only first fits.
    const results: readonly GuideSearchResult[] = [
      { title: "Short", content: "Brief content here for testing." },
      { title: "Also short", content: "Another brief bit of content." },
      { title: "Third", content: "Third result content for testing." },
    ];
    const tool = createAskGuideTool({ search: fixedSearch(results), maxTokens: 15 });
    const output = (await tool.execute({ question: "test" })) as {
      results: readonly GuideSearchResult[];
      totalFound: number;
      truncated: boolean;
    };

    expect(output.results.length).toBeLessThan(results.length);
    expect(output.totalFound).toBe(3);
    expect(output.truncated).toBe(true);
  });

  test("includes at least one result even if it exceeds budget", async () => {
    // Single large result exceeds budget but should still be included
    const results: readonly GuideSearchResult[] = [
      { title: "Big Result", content: "x".repeat(500) },
    ];
    const tool = createAskGuideTool({ search: fixedSearch(results), maxTokens: 10 });
    const output = (await tool.execute({ question: "test" })) as {
      results: readonly GuideSearchResult[];
      totalFound: number;
      truncated: boolean;
    };

    expect(output.results).toHaveLength(1);
    expect(output.truncated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  test("returns validation error for empty question", async () => {
    const tool = createAskGuideTool({ search: fixedSearch([]) });
    const output = (await tool.execute({ question: "" })) as { error: string; code: string };

    expect(output.code).toBe("VALIDATION");
    expect(output.error).toBeDefined();
  });

  test("returns validation error for missing question", async () => {
    const tool = createAskGuideTool({ search: fixedSearch([]) });
    const output = (await tool.execute({})) as { error: string; code: string };

    expect(output.code).toBe("VALIDATION");
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  test("returns error when search throws", async () => {
    const tool = createAskGuideTool({
      search: failingSearch(new Error("Search service unavailable")),
    });
    const output = (await tool.execute({ question: "test" })) as { error: string; code: string };

    expect(output.code).toBe("EXTERNAL");
    expect(output.error).toBe("Search service unavailable");
  });

  test("returns timeout error on abort", async () => {
    const tool = createAskGuideTool({
      search: async () => {
        throw new DOMException("Aborted", "AbortError");
      },
    });
    const output = (await tool.execute({ question: "test" })) as { error: string; code: string };

    expect(output.code).toBe("TIMEOUT");
  });

  // -------------------------------------------------------------------------
  // Provider wiring
  // -------------------------------------------------------------------------

  test("createAskGuideProvider returns a ComponentProvider", () => {
    const provider = createAskGuideProvider({ search: fixedSearch([]) });
    expect(provider.name).toBe("ask-guide");
    expect(typeof provider.attach).toBe("function");
  });
});
