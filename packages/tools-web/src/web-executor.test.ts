import { describe, expect, mock, test } from "bun:test";
import { createWebExecutor } from "./web-executor.js";

// ---------------------------------------------------------------------------
// fetch — basic
// ---------------------------------------------------------------------------

describe("createWebExecutor.fetch", () => {
  test("returns response for successful fetch", async () => {
    const fetchFn = mock(
      async () => new Response("Hello", { status: 200, headers: { "content-type": "text/plain" } }),
    ) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn });
    const result = await executor.fetch("https://example.com");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe(200);
      expect(result.value.body).toBe("Hello");
      expect(result.value.truncated).toBe(false);
    }
  });

  test("truncates large response bodies", async () => {
    const largeBody = "x".repeat(1000);
    const fetchFn = mock(
      async () => new Response(largeBody, { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, maxBodyChars: 100 });
    const result = await executor.fetch("https://example.com");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.body.length).toBe(100);
      expect(result.value.truncated).toBe(true);
    }
  });

  test("returns EXTERNAL error on network failure with retryable true", async () => {
    const fetchFn = mock(async () => {
      throw new Error("DNS resolution failed");
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn });
    const result = await executor.fetch("https://unreachable.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("DNS resolution failed");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("returns TIMEOUT error on abort", async () => {
    const fetchFn = mock(async () => {
      throw new Error("The operation was aborted");
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn });
    const result = await executor.fetch("https://slow.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  test("returns TIMEOUT when signal is pre-aborted", async () => {
    const fetchFn = mock(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
    const executor = createWebExecutor({ fetchFn });

    const controller = new AbortController();
    controller.abort();

    const result = await executor.fetch("https://example.com", { signal: controller.signal });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  test("captures response headers", async () => {
    const fetchFn = mock(
      async () =>
        new Response("", {
          status: 200,
          headers: { "x-custom": "value", "content-type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn });
    const result = await executor.fetch("https://example.com");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.headers["x-custom"]).toBe("value");
      expect(result.value.headers["content-type"]).toBe("application/json");
    }
  });

  test("includes finalUrl in result", async () => {
    const fetchFn = mock(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn });
    const result = await executor.fetch("https://example.com/page");

    expect(result.ok).toBe(true);
    if (result.ok) {
      // response.url is empty string in mock Response, falls back to original url
      expect(result.value.finalUrl).toBe("https://example.com/page");
    }
  });
});

// ---------------------------------------------------------------------------
// fetch — post-redirect SSRF check
// ---------------------------------------------------------------------------

describe("createWebExecutor.fetch post-redirect SSRF", () => {
  test("blocks redirect to localhost", async () => {
    const fetchFn = mock(async () => {
      const resp = new Response("secret", { status: 200 });
      // Simulate redirect by setting url property
      Object.defineProperty(resp, "url", { value: "http://localhost/admin" });
      return resp;
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn });
    const result = await executor.fetch("https://evil-redirect.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("Redirect");
      expect(result.error.message).toContain("localhost");
    }
  });

  test("blocks redirect to AWS metadata", async () => {
    const fetchFn = mock(async () => {
      const resp = new Response("", { status: 200 });
      Object.defineProperty(resp, "url", { value: "http://169.254.169.254/latest/meta-data/" });
      return resp;
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn });
    const result = await executor.fetch("https://evil.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("allows redirect to public URL", async () => {
    const fetchFn = mock(async () => {
      const resp = new Response("ok", { status: 200 });
      Object.defineProperty(resp, "url", { value: "https://www.example.com/redirected" });
      return resp;
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn });
    const result = await executor.fetch("https://example.com");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.finalUrl).toBe("https://www.example.com/redirected");
    }
  });
});

// ---------------------------------------------------------------------------
// fetch — caching
// ---------------------------------------------------------------------------

describe("createWebExecutor.fetch caching", () => {
  test("caches GET responses when cacheTtlMs > 0", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("cached", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000 });

    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(1);
  });

  test("does not cache when cacheTtlMs is 0", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("no-cache", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 0 });

    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("does not cache POST requests", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000 });

    await executor.fetch("https://example.com", { method: "POST" });
    await executor.fetch("https://example.com", { method: "POST" });
    expect(callCount).toBe(2);
  });

  test("caches different URLs separately", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000 });

    await executor.fetch("https://example.com/a");
    await executor.fetch("https://example.com/b");
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe("createWebExecutor.search", () => {
  test("returns VALIDATION when no searchFn provided", async () => {
    const executor = createWebExecutor({});
    const result = await executor.search("test query");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("delegates to searchFn when provided", async () => {
    const searchResults = [{ title: "Result", url: "https://example.com", snippet: "A result" }];
    const searchFn = mock(async () => ({
      ok: true as const,
      value: searchResults,
    }));

    const executor = createWebExecutor({ searchFn });
    const result = await executor.search("test");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.title).toBe("Result");
    }
  });

  test("wraps searchFn exceptions as EXTERNAL error", async () => {
    const searchFn = mock(async () => {
      throw new Error("API key expired");
    });

    const executor = createWebExecutor({ searchFn });
    const result = await executor.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("API key expired");
    }
  });

  test("caches search results when cacheTtlMs > 0", async () => {
    let callCount = 0;
    const searchFn = mock(async () => {
      callCount++;
      return { ok: true as const, value: [{ title: "R", url: "https://r.com", snippet: "s" }] };
    });

    const executor = createWebExecutor({ searchFn, cacheTtlMs: 60_000 });

    await executor.search("query");
    await executor.search("query");
    expect(callCount).toBe(1);
  });
});
