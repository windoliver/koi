/**
 * Type-level tests for @koi/search-provider.
 *
 * Verifies readonly enforcement and structural contracts at compile time.
 * Runtime assertions confirm the types are usable (not just optimized away).
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { SearchProvider, WebSearchOptions, WebSearchResult } from "./types.js";

describe("WebSearchResult", () => {
  test("is structurally correct", () => {
    const result: WebSearchResult = {
      title: "Example",
      url: "https://example.com",
      snippet: "An example result",
    };
    expect(result.title).toBe("Example");
    expect(result.url).toBe("https://example.com");
    expect(result.snippet).toBe("An example result");
  });
});

describe("WebSearchOptions", () => {
  test("allows all fields undefined", () => {
    const opts: WebSearchOptions = {};
    expect(opts.maxResults).toBeUndefined();
    expect(opts.signal).toBeUndefined();
  });

  test("accepts maxResults and signal", () => {
    const controller = new AbortController();
    const opts: WebSearchOptions = { maxResults: 5, signal: controller.signal };
    expect(opts.maxResults).toBe(5);
    expect(opts.signal).toBe(controller.signal);
  });
});

describe("SearchProvider", () => {
  test("satisfies the contract shape", async () => {
    const provider: SearchProvider = {
      name: "mock",
      search: async (
        _query: string,
        _options?: WebSearchOptions,
      ): Promise<Result<readonly WebSearchResult[], KoiError>> => ({
        ok: true,
        value: [{ title: "Mock", url: "https://mock.com", snippet: "Mock result" }],
      }),
    };

    expect(provider.name).toBe("mock");
    const result = await provider.search("test");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.title).toBe("Mock");
    }
  });

  test("can return error results", async () => {
    const provider: SearchProvider = {
      name: "failing",
      search: async (): Promise<Result<readonly WebSearchResult[], KoiError>> => ({
        ok: false,
        error: { code: "EXTERNAL", message: "API down", retryable: true },
      }),
    };

    const result = await provider.search("test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
    }
  });
});
