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
  test("returns search results from API", async () => {
    const fetchFn = mockFetch(() =>
      braveResponse([
        { title: "Result 1", url: "https://r1.com", description: "First" },
        { title: "Result 2", url: "https://r2.com", description: "Second" },
      ]),
    );

    const search = createBraveSearch({ apiKey: "test-key", fetchFn });
    const result = await search("test query");

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

    const search = createBraveSearch({ apiKey: "my-secret-key", fetchFn });
    await search("test");

    expect(capturedHeaders?.["X-Subscription-Token"]).toBe("my-secret-key");
  });

  test("passes query and count in URL params", async () => {
    let capturedUrl = "";
    const fetchFn = mockFetch((url) => {
      capturedUrl = url;
      return braveResponse([]);
    });

    const search = createBraveSearch({ apiKey: "key", fetchFn });
    await search("hello world", { maxResults: 3 });

    expect(capturedUrl).toContain("q=hello+world");
    expect(capturedUrl).toContain("count=3");
  });

  test("passes country and freshness params", async () => {
    let capturedUrl = "";
    const fetchFn = mockFetch((url) => {
      capturedUrl = url;
      return braveResponse([]);
    });

    const search = createBraveSearch({ apiKey: "key", fetchFn, country: "US", freshness: "pw" });
    await search("query");

    expect(capturedUrl).toContain("country=US");
    expect(capturedUrl).toContain("freshness=pw");
  });

  test("returns RATE_LIMIT error for 429", async () => {
    const fetchFn = mockFetch(() => new Response("", { status: 429 }));

    const search = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("returns PERMISSION error for 401", async () => {
    const fetchFn = mockFetch(() => new Response("", { status: 401 }));

    const search = createBraveSearch({ apiKey: "bad-key", fetchFn });
    const result = await search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("returns EXTERNAL error for 500", async () => {
    const fetchFn = mockFetch(() => new Response("", { status: 500 }));

    const search = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await search("test");

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

    const search = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await search("test");

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

    const search = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  test("returns TIMEOUT when signal is pre-aborted", async () => {
    const fetchFn = mockFetch(() => braveResponse([]));
    const search = createBraveSearch({ apiKey: "key", fetchFn });

    const controller = new AbortController();
    controller.abort();

    const result = await search("test", { signal: controller.signal });
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

    const search = createBraveSearch({ apiKey: "key", fetchFn });
    await search("test", { maxResults: 100 });
    expect(capturedUrl).toContain("count=20"); // capped at 20
  });

  test("handles empty web results gracefully", async () => {
    const fetchFn = mockFetch(() => Response.json({}));

    const search = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await search("empty");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });

  test("handles missing fields in results", async () => {
    const fetchFn = mockFetch(() => Response.json({ web: { results: [{}] } }));

    const search = createBraveSearch({ apiKey: "key", fetchFn });
    const result = await search("test");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.title).toBe("");
      expect(result.value[0]?.url).toBe("");
      expect(result.value[0]?.snippet).toBe("");
    }
  });
});
