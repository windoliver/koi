/**
 * Integration test: SearchProvider → WebExecutor → web_search tool.
 *
 * Validates the full chain from a concrete search provider (Brave, with mocked fetch)
 * through the WebExecutor to the tool execution layer.
 */

import { describe, expect, mock, test } from "bun:test";
import { createBraveSearch } from "@koi/search-brave";
import { createWebSearchTool } from "../tools/web-search.js";
import { createWebExecutor } from "../web-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(handler: (url: string) => Response): typeof globalThis.fetch {
  return mock(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url);
  }) as unknown as typeof globalThis.fetch;
}

function braveApiResponse(
  results: ReadonlyArray<{
    readonly title: string;
    readonly url: string;
    readonly description: string;
  }>,
): Response {
  return Response.json({ web: { results } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SearchProvider → WebExecutor integration", () => {
  test("full chain: BraveSearch provider → WebExecutor → search results", async () => {
    const fetchFn = mockFetch(() =>
      braveApiResponse([
        { title: "Koi Docs", url: "https://koi.dev/docs", description: "Official documentation" },
        { title: "Koi GitHub", url: "https://github.com/koi", description: "Source code" },
      ]),
    );

    // Create a real SearchProvider (Brave) with mocked fetch
    const searchProvider = createBraveSearch({ apiKey: "test-key", fetchFn });

    // Wire into WebExecutor via the new searchProvider config
    const executor = createWebExecutor({ searchProvider });

    // Execute search through the executor
    const result = await executor.search("koi agent engine");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.title).toBe("Koi Docs");
      expect(result.value[0]?.url).toBe("https://koi.dev/docs");
      expect(result.value[0]?.snippet).toBe("Official documentation");
      expect(result.value[1]?.title).toBe("Koi GitHub");
    }
  });

  test("full chain: SearchProvider → WebExecutor → web_search tool execute", async () => {
    const fetchFn = mockFetch(() =>
      braveApiResponse([
        { title: "Test Result", url: "https://test.com", description: "A test result" },
      ]),
    );

    const searchProvider = createBraveSearch({ apiKey: "test-key", fetchFn });
    const executor = createWebExecutor({ searchProvider });
    const tool = createWebSearchTool(executor, "web", "sandbox");

    expect(tool.descriptor.name).toBe("web_search");

    // Execute the tool with query args
    const result = await tool.execute({ query: "test", max_results: 1 });

    // Tool returns an object with query, results, and count
    expect(result).toBeDefined();
    const typedResult = result as {
      readonly query: string;
      readonly results: readonly unknown[];
      readonly count: number;
    };
    expect(typedResult.query).toBe("test");
    expect(typedResult.results).toHaveLength(1);
    expect(typedResult.count).toBe(1);
  });

  test("caching works across SearchProvider calls via executor", async () => {
    let fetchCallCount = 0;
    const fetchFn = mockFetch(() => {
      fetchCallCount++;
      return braveApiResponse([
        { title: "Cached", url: "https://cached.com", description: "Cached result" },
      ]);
    });

    const searchProvider = createBraveSearch({ apiKey: "test-key", fetchFn });
    const executor = createWebExecutor({ searchProvider, cacheTtlMs: 60_000 });

    await executor.search("cache test");
    await executor.search("cache test");
    await executor.search("cache test");

    // Only 1 actual fetch call — subsequent calls served from cache
    expect(fetchCallCount).toBe(1);
  });

  test("error propagation: provider error flows through executor", async () => {
    const fetchFn = mockFetch(() => new Response("", { status: 429 }));

    const searchProvider = createBraveSearch({ apiKey: "test-key", fetchFn });
    const executor = createWebExecutor({ searchProvider });
    const result = await executor.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
    }
  });
});
