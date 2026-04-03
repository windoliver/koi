import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { ChubSearchResult, ContextHubExecutor } from "../context-hub-executor.js";
import { createChubSearchTool } from "./chub-search.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_RESULTS: readonly ChubSearchResult[] = [
  {
    id: "stripe/payments",
    name: "Stripe Payments API",
    description: "Accept payments online",
    tags: ["payments", "billing"],
    source: "official",
    languages: [
      {
        language: "javascript",
        recommendedVersion: "2.0.0",
        size: 5000,
        lastUpdated: "2026-01-01",
      },
      { language: "python", recommendedVersion: "2.0.0", size: 4800, lastUpdated: "2026-01-01" },
    ],
  },
  {
    id: "openai/chat",
    name: "OpenAI Chat Completions",
    description: "Generate text with GPT",
    tags: ["ai", "llm"],
    source: "community",
    languages: [
      { language: "python", recommendedVersion: "1.0.0", size: 3000, lastUpdated: "2025-12-01" },
    ],
  },
];

function fixedExecutor(results: readonly ChubSearchResult[]): ContextHubExecutor {
  return {
    search: async (_query, _max) =>
      ({ ok: true, value: results }) as Result<readonly ChubSearchResult[], KoiError>,
    get: async () => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "Not implemented", retryable: false },
    }),
  };
}

function failingExecutor(error: KoiError): ContextHubExecutor {
  return {
    search: async () => ({ ok: false, error }),
    get: async () => ({ ok: false, error }),
  };
}

function createTool(
  executor: ContextHubExecutor = fixedExecutor(FIXTURE_RESULTS),
): ReturnType<typeof createChubSearchTool> {
  return createChubSearchTool(executor, "chub", DEFAULT_UNSANDBOXED_POLICY);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createChubSearchTool", () => {
  // Descriptor
  test("descriptor has correct name and schema", () => {
    const tool = createTool();
    expect(tool.descriptor.name).toBe("chub_search");
    expect(tool.descriptor.inputSchema.required).toContain("query");
    expect(tool.origin).toBe("primordial");
  });

  // Happy path
  test("returns ranked results for valid query", async () => {
    const tool = createTool();
    const output = (await tool.execute({ query: "stripe payments" })) as {
      query: string;
      results: readonly ChubSearchResult[];
      count: number;
    };

    expect(output.query).toBe("stripe payments");
    expect(output.results).toHaveLength(2);
    expect(output.count).toBe(2);
    expect(output.results[0]?.id).toBe("stripe/payments");
  });

  test("results include rich metadata (languages, source, tags)", async () => {
    const tool = createTool();
    const output = (await tool.execute({ query: "stripe" })) as {
      results: readonly ChubSearchResult[];
    };

    const first = output.results[0];
    expect(first?.source).toBe("official");
    expect(first?.tags).toContain("payments");
    expect(first?.languages.length).toBeGreaterThan(0);
    expect(first?.languages[0]?.language).toBe("javascript");
    expect(first?.languages[0]?.recommendedVersion).toBe("2.0.0");
  });

  // Zero results
  test("returns empty results with hint when no matches found", async () => {
    const tool = createTool(fixedExecutor([]));
    const output = (await tool.execute({ query: "nonexistent api" })) as {
      results: readonly ChubSearchResult[];
      count: number;
      hint: string;
    };

    expect(output.results).toEqual([]);
    expect(output.count).toBe(0);
    expect(output.hint).toBeDefined();
    expect(output.hint.length).toBeGreaterThan(0);
  });

  // maxResults
  test("clamps max_results to valid range", async () => {
    let capturedMax: number | undefined;
    const capturingExecutor: ContextHubExecutor = {
      search: async (_query, max) => {
        capturedMax = max;
        return { ok: true, value: [] };
      },
      get: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "", retryable: false } }),
    };

    const tool = createChubSearchTool(capturingExecutor, "chub", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ query: "test", max_results: 100 });
    expect(capturedMax).toBe(20); // clamped to MAX_MAX_RESULTS
  });

  // Validation
  test("returns validation error for empty query", async () => {
    const tool = createTool();
    const output = (await tool.execute({ query: "" })) as { error: string; code: string };

    expect(output.code).toBe("VALIDATION");
  });

  test("returns validation error for missing query", async () => {
    const tool = createTool();
    const output = (await tool.execute({})) as { error: string; code: string };

    expect(output.code).toBe("VALIDATION");
  });

  // Error handling
  test("returns REGISTRY_UNAVAILABLE when CDN is down", async () => {
    const tool = createTool(
      failingExecutor({ code: "EXTERNAL", message: "CDN unreachable", retryable: true }),
    );
    const output = (await tool.execute({ query: "stripe" })) as { error: string; code: string };

    expect(output.code).toBe("EXTERNAL");
    expect(output.error).toBe("CDN unreachable");
  });

  test("returns TIMEOUT on timeout", async () => {
    const tool = createTool(
      failingExecutor({ code: "TIMEOUT", message: "Request timed out", retryable: true }),
    );
    const output = (await tool.execute({ query: "stripe" })) as { error: string; code: string };

    expect(output.code).toBe("TIMEOUT");
  });
});
