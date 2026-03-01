import { describe, expect, mock, test } from "bun:test";
import { createBraveSearch } from "./brave-search.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(handler: (url: string) => Response): typeof globalThis.fetch {
  return mock(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url);
  }) as unknown as typeof globalThis.fetch;
}

function braveResponse(
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

describe("createBraveSearch", () => {
  test("returns a SearchProvider with name 'brave'", () => {
    const provider = createBraveSearch({
      apiKey: "test-key",
      fetchFn: mockFetch(() => braveResponse([])),
    });
    expect(provider.name).toBe("brave");
    expect(typeof provider.search).toBe("function");
  });

  test("returns search results from API", async () => {
    const fetchFn = mockFetch(() =>
      braveResponse([
        { title: "Result 1", url: "https://r1.com", description: "First" },
        { title: "Result 2", url: "https://r2.com", description: "Second" },
      ]),
    );

    const provider = createBraveSearch({ apiKey: "test-key", fetchFn });
    const result = await provider.search("test query");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.title).toBe("Result 1");
      expect(result.value[0]?.snippet).toBe("First");
    }
  });

  test("sends API key in X-Subscription-Token header", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchFn = mock(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        capturedHeaders = init?.headers as Record<string, string> | undefined;
        return braveResponse([]);
      },
    ) as unknown as typeof globalThis.fetch;

    const provider = createBraveSearch({ apiKey: "my-secret-key", fetchFn });
    await provider.search("test");

    expect(capturedHeaders?.["X-Subscription-Token"]).toBe("my-secret-key");
  });

  test("passes query and count in URL params", async () => {
    let capturedUrl = "";
    const fetchFn = mockFetch((url) => {
      capturedUrl = url;
      return braveResponse([]);
    });

    const provider = createBraveSearch({ apiKey: "key", fetchFn });
    await provider.search("hello world", { maxResults: 3 });

    expect(capturedUrl).toContain("q=hello+world");
    expect(capturedUrl).toContain("count=3");
  });

  test("passes country and freshness params", async () => {
    let capturedUrl = "";
    const fetchFn = mockFetch((url) => {
      capturedUrl = url;
      return braveResponse([]);
    });

    const provider = createBraveSearch({ apiKey: "key", fetchFn, country: "US", freshness: "pw" });
    await provider.search("query");

    expect(capturedUrl).toContain("country=US");
    expect(capturedUrl).toContain("freshness=pw");
  });

  test("returns RATE_LIMIT error for 429", async () => {
    const fetchFn = mockFetch(() => new Response("", { status: 429 }));

    const provider = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await provider.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("returns PERMISSION error for 401", async () => {
    const fetchFn = mockFetch(() => new Response("", { status: 401 }));

    const provider = createBraveSearch({ apiKey: "bad-key", fetchFn });
    const result = await provider.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("returns EXTERNAL error for 500", async () => {
    const fetchFn = mockFetch(() => new Response("", { status: 500 }));

    const provider = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await provider.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("returns EXTERNAL error on network failure", async () => {
    const fetchFn = mockFetch(() => {
      throw new Error("Network error");
    });

    const provider = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await provider.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("Network error");
    }
  });

  test("returns TIMEOUT error on abort", async () => {
    const fetchFn = mockFetch(() => {
      throw new Error("The operation was aborted");
    });

    const provider = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await provider.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  test("returns TIMEOUT when signal is pre-aborted", async () => {
    const fetchFn = mockFetch(() => braveResponse([]));
    const provider = createBraveSearch({ apiKey: "key", fetchFn });

    const controller = new AbortController();
    controller.abort();

    const result = await provider.search("test", { signal: controller.signal });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  test("clamps maxResults to valid range", async () => {
    let capturedUrl = "";
    const fetchFn = mockFetch((url) => {
      capturedUrl = url;
      return braveResponse([]);
    });

    const provider = createBraveSearch({ apiKey: "key", fetchFn });
    await provider.search("test", { maxResults: 100 });
    expect(capturedUrl).toContain("count=20"); // capped at 20
  });

  test("handles empty web results gracefully", async () => {
    const fetchFn = mockFetch(() => Response.json({}));

    const provider = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await provider.search("empty");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });

  test("handles missing fields in results", async () => {
    const fetchFn = mockFetch(() => Response.json({ web: { results: [{}] } }));

    const provider = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await provider.search("test");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.title).toBe("");
      expect(result.value[0]?.url).toBe("");
      expect(result.value[0]?.snippet).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Retry-After parsing
// ---------------------------------------------------------------------------

describe("Retry-After header parsing", () => {
  test("parses numeric Retry-After: 30 into retryAfterMs 30000", async () => {
    const fetchFn = mockFetch(
      () => new Response("", { status: 429, headers: { "retry-after": "30" } }),
    );

    const provider = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await provider.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.context?.retryAfterMs).toBe(30_000);
    }
  });

  test("parses Retry-After: 0 into retryAfterMs 0", async () => {
    const fetchFn = mockFetch(
      () => new Response("", { status: 429, headers: { "retry-after": "0" } }),
    );

    const provider = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await provider.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.retryAfterMs).toBe(0);
    }
  });

  test("returns undefined retryAfterMs when no Retry-After header", async () => {
    const fetchFn = mockFetch(() => new Response("", { status: 429 }));

    const provider = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await provider.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.retryAfterMs).toBeUndefined();
    }
  });

  test("returns undefined retryAfterMs for non-numeric Retry-After", async () => {
    const fetchFn = mockFetch(
      () => new Response("", { status: 429, headers: { "retry-after": "abc" } }),
    );

    const provider = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await provider.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.retryAfterMs).toBeUndefined();
    }
  });
});
