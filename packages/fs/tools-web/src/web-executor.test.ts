import { describe, expect, mock, test } from "bun:test";
import type { SearchProvider } from "@koi/search-provider";
import type { DnsResolverFn } from "./url-policy.js";
import { createWebExecutor } from "./web-executor.js";

// ---------------------------------------------------------------------------
// Shared mock DNS resolver — returns a public IP for all hostnames
// ---------------------------------------------------------------------------

const PUBLIC_IP = "93.184.216.34"; // example.com's real public IP
const mockDnsResolver: DnsResolverFn = async (): Promise<readonly string[]> => [PUBLIC_IP];

// ---------------------------------------------------------------------------
// fetch — basic
// ---------------------------------------------------------------------------

describe("createWebExecutor.fetch", () => {
  test("returns response for successful fetch", async () => {
    const fetchFn = mock(
      async () => new Response("Hello", { status: 200, headers: { "content-type": "text/plain" } }),
    ) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
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

    const executor = createWebExecutor({ fetchFn, maxBodyChars: 100, dnsResolver: mockDnsResolver });
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

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
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

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    const result = await executor.fetch("https://slow.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  test("returns TIMEOUT when signal is pre-aborted", async () => {
    const fetchFn = mock(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });

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

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
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

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    const result = await executor.fetch("https://example.com/page");

    expect(result.ok).toBe(true);
    if (result.ok) {
      // response.url is empty string in mock Response, falls back to original url
      expect(result.value.finalUrl).toBe("https://example.com/page");
    }
  });
});

// ---------------------------------------------------------------------------
// fetch — pre-redirect SSRF check (manual redirect following)
// ---------------------------------------------------------------------------

describe("createWebExecutor.fetch redirect SSRF", () => {
  test("blocks redirect to localhost BEFORE following", async () => {
    const mutableCalls: string[] = [];
    const fetchFn = mock(async (input: string | URL | Request) => {
      const reqUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      mutableCalls.push(reqUrl);
      // First call: return a 302 redirecting to localhost
      if (reqUrl.includes("evil-redirect")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://localhost/admin" },
        });
      }
      // Should never reach here — redirect must be blocked
      return new Response("secret", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    const result = await executor.fetch("https://evil-redirect.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("Redirect");
      expect(result.error.message).toContain("localhost");
    }
    // Verify we never fetched the localhost URL
    expect(mutableCalls).toHaveLength(1);
    expect(mutableCalls[0]).toBe("https://evil-redirect.example.com");
  });

  test("blocks redirect to AWS metadata BEFORE following", async () => {
    const mutableCalls: string[] = [];
    const fetchFn = mock(async (input: string | URL | Request) => {
      const reqUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      mutableCalls.push(reqUrl);
      if (reqUrl.includes("evil.example.com")) {
        return new Response(null, {
          status: 301,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    const result = await executor.fetch("https://evil.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
    // Verify the metadata URL was never actually fetched
    expect(mutableCalls).toHaveLength(1);
  });

  test("allows redirect to public URL", async () => {
    const fetchFn = mock(async (input: string | URL | Request) => {
      const reqUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (reqUrl === "https://example.com") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.example.com/redirected" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    const result = await executor.fetch("https://example.com");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.finalUrl).toBe("https://www.example.com/redirected");
    }
  });

  test("follows multiple redirects and tracks finalUrl", async () => {
    const fetchFn = mock(async (input: string | URL | Request) => {
      const reqUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (reqUrl === "https://a.example.com") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://b.example.com/step2" },
        });
      }
      if (reqUrl === "https://b.example.com/step2") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://c.example.com/final" },
        });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    const result = await executor.fetch("https://a.example.com");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.finalUrl).toBe("https://c.example.com/final");
      expect(result.value.body).toBe("done");
    }
  });

  test("blocks SSRF on intermediate redirect hop", async () => {
    const mutableCalls: string[] = [];
    const fetchFn = mock(async (input: string | URL | Request) => {
      const reqUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      mutableCalls.push(reqUrl);
      if (reqUrl === "https://a.example.com") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.example.com/step2" },
        });
      }
      if (reqUrl === "https://b.example.com/step2") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://10.0.0.1/internal" },
        });
      }
      return new Response("secret", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    const result = await executor.fetch("https://a.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("10.0.0.1");
    }
    // a.example.com and b.example.com were fetched, but 10.0.0.1 was not
    expect(mutableCalls).toHaveLength(2);
  });

  test("does not leak stale Host header on http-to-https cross-origin redirect", async () => {
    const mutableHeaderSnaps: Record<string, string | undefined>[] = [];
    const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const reqUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = init?.headers as Record<string, string> | undefined;
      mutableHeaderSnaps.push({ url: reqUrl, Host: headers?.Host });
      if (reqUrl.includes(PUBLIC_IP) || reqUrl.includes("a.example")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.example/next" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    const result = await executor.fetch("http://a.example/start");

    expect(result.ok).toBe(true);
    // First hop: HTTP, pinned — Host should be "a.example"
    expect(mutableHeaderSnaps[0]?.Host).toBe("a.example");
    // Second hop: HTTPS, can't pin — Host must NOT be "a.example"
    expect(mutableHeaderSnaps[1]?.Host).toBeUndefined();
  });

  test("returns error when exceeding max redirects", async () => {
    const fetchFn = mock(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "https://loop.example.com/next" },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    const result = await executor.fetch("https://loop.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("Too many redirects");
    }
  });

  test("resolves relative redirect URLs", async () => {
    const fetchFn = mock(async (input: string | URL | Request) => {
      const reqUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (reqUrl === "https://example.com/old") {
        return new Response(null, {
          status: 301,
          headers: { location: "/new-path" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    const result = await executor.fetch("https://example.com/old");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.finalUrl).toBe("https://example.com/new-path");
    }
  });

  test("303 converts POST to GET", async () => {
    const mutableMethods: string[] = [];
    const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const reqUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      mutableMethods.push(init?.method ?? "GET");
      if (reqUrl === "https://example.com/submit") {
        return new Response(null, {
          status: 303,
          headers: { location: "https://example.com/result" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    const result = await executor.fetch("https://example.com/submit", {
      method: "POST",
      body: "data",
    });

    expect(result.ok).toBe(true);
    expect(mutableMethods).toEqual(["POST", "GET"]);
  });
});

// ---------------------------------------------------------------------------
// fetch — cross-origin credential stripping
// ---------------------------------------------------------------------------

describe("createWebExecutor.fetch cross-origin credential stripping", () => {
  test("strips sensitive headers on cross-origin redirect", async () => {
    const mutableHeaderSnaps: Record<string, string>[] = [];
    const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const reqUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Capture headers passed to each hop
      mutableHeaderSnaps.push({ ...(init?.headers as Record<string, string>) });
      if (reqUrl === "https://origin-a.com/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://origin-b.com/landing" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    const result = await executor.fetch("https://origin-a.com/start", {
      headers: {
        Authorization: "Bearer secret",
        Cookie: "session=abc",
        "Proxy-Authorization": "Basic xyz",
        "Content-Type": "text/plain",
      },
    });

    expect(result.ok).toBe(true);
    // First hop: all headers present
    expect(mutableHeaderSnaps[0]).toEqual({
      Authorization: "Bearer secret",
      Cookie: "session=abc",
      "Proxy-Authorization": "Basic xyz",
      "Content-Type": "text/plain",
    });
    // Second hop (cross-origin): sensitive headers stripped, non-sensitive kept
    expect(mutableHeaderSnaps[1]).toEqual({
      "Content-Type": "text/plain",
    });
  });

  test("preserves all headers on same-origin redirect", async () => {
    const mutableHeaderSnaps: Record<string, string>[] = [];
    const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const reqUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      mutableHeaderSnaps.push({ ...(init?.headers as Record<string, string>) });
      if (reqUrl === "https://example.com/a") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.com/b" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    await executor.fetch("https://example.com/a", {
      headers: { Authorization: "Bearer secret", "X-Custom": "keep" },
    });

    // Same origin — all headers preserved on second hop
    expect(mutableHeaderSnaps[1]).toEqual({
      Authorization: "Bearer secret",
      "X-Custom": "keep",
    });
  });

  test("strips credentials once on cross-origin and keeps them stripped for subsequent hops", async () => {
    const mutableHeaderSnaps: Record<string, string>[] = [];
    const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const reqUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      mutableHeaderSnaps.push({ ...(init?.headers as Record<string, string>) });
      if (reqUrl === "https://a.com/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.com/step2" },
        });
      }
      if (reqUrl === "https://b.com/step2") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://c.com/final" },
        });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    await executor.fetch("https://a.com/start", {
      headers: { Authorization: "Bearer token", Accept: "text/html" },
    });

    // Hop 0 (a.com): all headers
    expect(mutableHeaderSnaps[0]?.Authorization).toBe("Bearer token");
    expect(mutableHeaderSnaps[0]?.Accept).toBe("text/html");
    // Hop 1 (b.com, cross-origin): Authorization stripped
    expect(mutableHeaderSnaps[1]?.Authorization).toBeUndefined();
    expect(mutableHeaderSnaps[1]?.Accept).toBe("text/html");
    // Hop 2 (c.com, cross-origin from b.com): still stripped
    expect(mutableHeaderSnaps[2]?.Authorization).toBeUndefined();
    expect(mutableHeaderSnaps[2]?.Accept).toBe("text/html");
  });

  test("handles case-insensitive header names for stripping", async () => {
    const mutableHeaderSnaps: Record<string, string>[] = [];
    const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const reqUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      mutableHeaderSnaps.push({ ...(init?.headers as Record<string, string>) });
      if (reqUrl === "https://a.com/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.com/" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    await executor.fetch("https://a.com/", {
      headers: { AUTHORIZATION: "Bearer upper", cookie: "lower=val" },
    });

    // Cross-origin: both should be stripped regardless of case
    expect(mutableHeaderSnaps[1]?.AUTHORIZATION).toBeUndefined();
    expect(mutableHeaderSnaps[1]?.cookie).toBeUndefined();
  });

  test("does not strip headers when no headers are provided", async () => {
    const fetchFn = mock(async (input: string | URL | Request) => {
      const reqUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (reqUrl === "https://a.com/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.com/" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, dnsResolver: mockDnsResolver });
    const result = await executor.fetch("https://a.com/");

    // Should succeed without errors when there are no headers to strip
    expect(result.ok).toBe(true);
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

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, dnsResolver: mockDnsResolver });

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

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 0, dnsResolver: mockDnsResolver });

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

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, dnsResolver: mockDnsResolver });

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

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, dnsResolver: mockDnsResolver });

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

  test("returns VALIDATION when no searchProvider or searchFn", async () => {
    const executor = createWebExecutor({});
    const result = await executor.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("searchProvider");
    }
  });
});

// ---------------------------------------------------------------------------
// search — SearchProvider interface
// ---------------------------------------------------------------------------

describe("createWebExecutor.search with SearchProvider", () => {
  test("delegates to searchProvider.search", async () => {
    const searchResults = [{ title: "Result", url: "https://example.com", snippet: "A result" }];
    const searchProvider: SearchProvider = {
      name: "mock",
      search: mock(async () => ({
        ok: true as const,
        value: searchResults,
      })),
    };

    const executor = createWebExecutor({ searchProvider });
    const result = await executor.search("test");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.title).toBe("Result");
    }
  });

  test("searchProvider takes precedence over searchFn", async () => {
    let providerCalled = false;
    let fnCalled = false;

    const searchProvider: SearchProvider = {
      name: "mock",
      search: async () => {
        providerCalled = true;
        return { ok: true as const, value: [] };
      },
    };
    const searchFn = async () => {
      fnCalled = true;
      return {
        ok: true as const,
        value: [] as { readonly title: string; readonly url: string; readonly snippet: string }[],
      };
    };

    const executor = createWebExecutor({ searchProvider, searchFn });
    await executor.search("test");

    expect(providerCalled).toBe(true);
    expect(fnCalled).toBe(false);
  });

  test("normalizes cache key: same query with different case hits cache", async () => {
    let callCount = 0;
    const searchProvider: SearchProvider = {
      name: "mock",
      search: async () => {
        callCount++;
        return { ok: true as const, value: [{ title: "R", url: "https://r.com", snippet: "s" }] };
      },
    };

    const executor = createWebExecutor({ searchProvider, cacheTtlMs: 60_000 });

    await executor.search("Hello World");
    await executor.search("hello world");
    await executor.search("  HELLO WORLD  ");
    expect(callCount).toBe(1);
  });

  test("wraps searchProvider exceptions as error", async () => {
    const searchProvider: SearchProvider = {
      name: "failing",
      search: async () => {
        throw new Error("Provider crashed");
      },
    };

    const executor = createWebExecutor({ searchProvider });
    const result = await executor.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Provider crashed");
    }
  });
});
