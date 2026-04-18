import { describe, expect, mock, test } from "bun:test";
import type { DnsResolverFn } from "./url-policy.js";
import type { SearchProvider } from "./web-executor.js";
import { createWebExecutor } from "./web-executor.js";

// ---------------------------------------------------------------------------
// Shared mock DNS resolver — returns a public IP for all hostnames
// ---------------------------------------------------------------------------

const PUBLIC_IP = "93.184.216.34"; // example.com's real public IP
const mockDnsResolver: DnsResolverFn = async (): Promise<readonly string[]> => [PUBLIC_IP];

/** Base config for tests — mock DNS + HTTPS opt-in (default is false). */
const HTTPS_DEFAULTS = { dnsResolver: mockDnsResolver, allowHttps: true } as const;

// ---------------------------------------------------------------------------
// fetch — basic
// ---------------------------------------------------------------------------

describe("createWebExecutor.fetch", () => {
  test("returns response for successful fetch", async () => {
    const fetchFn = mock(
      async () => new Response("Hello", { status: 200, headers: { "content-type": "text/plain" } }),
    ) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
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

    const executor = createWebExecutor({
      fetchFn,
      maxBodyChars: 100,
      ...HTTPS_DEFAULTS,
    });
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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
    const result = await executor.fetch("https://slow.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  test("returns TIMEOUT when signal is pre-aborted", async () => {
    const fetchFn = mock(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });

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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
    const result = await executor.fetch("https://example.com/page");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.finalUrl).toBe("https://example.com/page");
    }
  });
});

// ---------------------------------------------------------------------------
// fetch — initial SSRF string-level gate
// ---------------------------------------------------------------------------

describe("createWebExecutor.fetch initial SSRF gate", () => {
  test("blocks localhost even when DNS resolver returns public IP", async () => {
    const fetchFn = mock(async () => new Response("secret")) as unknown as typeof globalThis.fetch;
    const executor = createWebExecutor({
      fetchFn,
      dnsResolver: mockDnsResolver,
      allowHttps: false,
    });
    const result = await executor.fetch("http://localhost/admin");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("localhost");
    }
  });

  test("blocks .internal domain even when DNS resolver returns public IP", async () => {
    const fetchFn = mock(async () => new Response("secret")) as unknown as typeof globalThis.fetch;
    const executor = createWebExecutor({
      fetchFn,
      dnsResolver: mockDnsResolver,
      allowHttps: false,
    });
    const result = await executor.fetch("http://service.internal/api");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("blocks private IP URL before DNS resolution", async () => {
    let dnsResolved = false;
    const trackingResolver: DnsResolverFn = async () => {
      dnsResolved = true;
      return [PUBLIC_IP];
    };
    const fetchFn = mock(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
    const executor = createWebExecutor({
      fetchFn,
      dnsResolver: trackingResolver,
      allowHttps: false,
    });
    const result = await executor.fetch("http://10.0.0.1/internal");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
    // DNS should never have been called — blocked at string level
    expect(dnsResolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetch — retryable flag respects HTTP method safety
// ---------------------------------------------------------------------------

describe("createWebExecutor.fetch retryable", () => {
  test("GET failure is retryable", async () => {
    const fetchFn = mock(async () => {
      throw new Error("Connection reset");
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
    const result = await executor.fetch("https://example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
    }
  });

  test("POST failure is NOT retryable", async () => {
    const fetchFn = mock(async () => {
      throw new Error("Connection reset");
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
    const result = await executor.fetch("https://example.com", { method: "POST" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(false);
    }
  });

  test("DELETE failure is NOT retryable", async () => {
    const fetchFn = mock(async () => {
      throw new Error("Connection reset");
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
    const result = await executor.fetch("https://example.com", { method: "DELETE" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(false);
    }
  });

  test("timeout is never retryable regardless of method", async () => {
    const fetchFn = mock(async () => {
      throw new Error("The operation was aborted");
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
    const result = await executor.fetch("https://example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(false);
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
      if (reqUrl.includes("evil-redirect")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://localhost/admin" },
        });
      }
      return new Response("secret", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
    const result = await executor.fetch("https://evil-redirect.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("Redirect");
      expect(result.error.message).toContain("localhost");
    }
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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
    const result = await executor.fetch("https://evil.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
    const result = await executor.fetch("https://a.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("10.0.0.1");
    }
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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
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
      mutableHeaderSnaps.push({ ...(init?.headers as Record<string, string>) });
      if (reqUrl === "https://origin-a.com/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://origin-b.com/landing" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
    const result = await executor.fetch("https://origin-a.com/start", {
      headers: {
        Authorization: "Bearer secret",
        Cookie: "session=abc",
        "Proxy-Authorization": "Basic xyz",
        "Content-Type": "text/plain",
      },
    });

    expect(result.ok).toBe(true);
    expect(mutableHeaderSnaps[0]).toEqual({
      Authorization: "Bearer secret",
      Cookie: "session=abc",
      "Proxy-Authorization": "Basic xyz",
      "Content-Type": "text/plain",
    });
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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
    await executor.fetch("https://example.com/a", {
      headers: { Authorization: "Bearer secret", "X-Custom": "keep" },
    });

    expect(mutableHeaderSnaps[1]).toEqual({
      Authorization: "Bearer secret",
      "X-Custom": "keep",
    });
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

    const executor = createWebExecutor({ fetchFn, ...HTTPS_DEFAULTS });
    await executor.fetch("https://a.com/", {
      headers: { AUTHORIZATION: "Bearer upper", cookie: "lower=val" },
    });

    expect(mutableHeaderSnaps[1]?.AUTHORIZATION).toBeUndefined();
    expect(mutableHeaderSnaps[1]?.cookie).toBeUndefined();
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

    const executor = createWebExecutor({
      fetchFn,
      cacheTtlMs: 60_000,
      ...HTTPS_DEFAULTS,
    });

    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(1);
  });

  test("marks cache hits with cached=true and misses with cached=false", async () => {
    const fetchFn = mock(
      async () => new Response("body", { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    const first = await executor.fetch("https://example.com");
    const second = await executor.fetch("https://example.com");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) expect(first.value.cached).toBe(false);
    if (second.ok) expect(second.value.cached).toBe(true);
  });

  test("does not cache when cacheTtlMs is 0", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("no-cache", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 0, ...HTTPS_DEFAULTS });

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

    const executor = createWebExecutor({
      fetchFn,
      cacheTtlMs: 60_000,
      ...HTTPS_DEFAULTS,
    });

    await executor.fetch("https://example.com", { method: "POST" });
    await executor.fetch("https://example.com", { method: "POST" });
    expect(callCount).toBe(2);
  });

  test("does not cache requests with credential headers", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("secret", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({
      fetchFn,
      cacheTtlMs: 60_000,
      ...HTTPS_DEFAULTS,
    });

    await executor.fetch("https://example.com", {
      headers: { Authorization: "Bearer token" },
    });
    await executor.fetch("https://example.com", {
      headers: { Authorization: "Bearer token" },
    });
    // Must hit backend both times — credential responses are caller-specific
    expect(callCount).toBe(2);
  });

  test("does not cache requests with Cookie header", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("session-data", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({
      fetchFn,
      cacheTtlMs: 60_000,
      ...HTTPS_DEFAULTS,
    });

    await executor.fetch("https://example.com", {
      headers: { Cookie: "session=abc" },
    });
    await executor.fetch("https://example.com", {
      headers: { Cookie: "session=abc" },
    });
    expect(callCount).toBe(2);
  });

  test("does not cache requests with any custom headers (prevents cache poisoning)", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({
      fetchFn,
      cacheTtlMs: 60_000,
      ...HTTPS_DEFAULTS,
    });

    // Accept header changes response representation — must not serve cached variant
    await executor.fetch("https://example.com", {
      headers: { Accept: "application/json" },
    });
    await executor.fetch("https://example.com", {
      headers: { Accept: "text/html" },
    });
    expect(callCount).toBe(2);
  });

  test("does not cache requests with Range header", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("partial", { status: 206 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({
      fetchFn,
      cacheTtlMs: 60_000,
      ...HTTPS_DEFAULTS,
    });

    await executor.fetch("https://example.com/file", {
      headers: { Range: "bytes=0-100" },
    });
    await executor.fetch("https://example.com/file", {
      headers: { Range: "bytes=100-200" },
    });
    expect(callCount).toBe(2);
  });

  test("caches different URLs separately", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({
      fetchFn,
      cacheTtlMs: 60_000,
      ...HTTPS_DEFAULTS,
    });

    await executor.fetch("https://example.com/a");
    await executor.fetch("https://example.com/b");
    expect(callCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Cache safety: only replayable success responses are stored (#1903 review)
  // -------------------------------------------------------------------------

  test("does not cache 5xx responses (transient failures must not stick)", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      // First call errors out, second would recover if the cache did NOT
      // replay the failure.
      return new Response("maintenance", { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("does not cache 429 rate-limit responses", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("slow down", { status: 429 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("does not cache 206 partial-content responses", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("half", { status: 206 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("does not cache responses with Cache-Control: no-store", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("volatile", {
        status: 200,
        headers: { "cache-control": "no-store, max-age=0" },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("does not cache responses with Cache-Control: private", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("user-specific", {
        status: 200,
        headers: { "cache-control": "private, max-age=300" },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("noCache=true forces a live fetch (read bypass)", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("fresh", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com");
    const bypassed = await executor.fetch("https://example.com", { noCache: true });
    expect(callCount).toBe(2);
    if (bypassed.ok) expect(bypassed.value.cached).toBe(false);
  });

  test("successful noCache fetch refreshes the cached entry (no stale replay)", async () => {
    // Regression for #1903 review round 2: a `noCache` fetch must not
    // leave a pre-existing stale entry live for subsequent default callers.
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      const body = callCount === 1 ? "old" : "new";
      return new Response(body, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com"); // prime: "old"
    const forced = await executor.fetch("https://example.com", { noCache: true }); // "new"
    const followUp = await executor.fetch("https://example.com"); // must see "new"

    expect(callCount).toBe(2);
    if (forced.ok) {
      expect(forced.value.body).toBe("new");
      expect(forced.value.cached).toBe(false);
    }
    if (followUp.ok) {
      expect(followUp.value.body).toBe("new");
      expect(followUp.value.cached).toBe(true);
    }
  });

  test("noCache with non-cacheable response evicts the prior entry (known-stale)", async () => {
    // If the caller forces a live fetch and origin returns something we
    // can't cache (transient 5xx, 206, no-store), the prior entry is now
    // known-stale. Evict so the next default caller hits origin again.
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      if (callCount === 1) return new Response("old", { status: 200 });
      if (callCount === 2) return new Response("err", { status: 500 });
      return new Response("new", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com", { noCache: true }); // 500 → evicts
    const followUp = await executor.fetch("https://example.com"); // must hit origin

    expect(callCount).toBe(3);
    if (followUp.ok) {
      expect(followUp.value.body).toBe("new");
      expect(followUp.value.cached).toBe(false);
    }
  });

  test("noCache that fails before reaching origin leaves the key empty (no stale fallback)", async () => {
    // Regression for #1903 review round 9: `noCache` promises "do not
    // serve stale, period." A forced-fresh request that fails anywhere
    // in the pipeline (caller abort, transport error, SSRF rejection)
    // must return the error AND leave the key empty. Subsequent default
    // callers must hit origin themselves — they must NOT be silently
    // served the stale entry the forced-fresh call explicitly rejected.
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      if (callCount === 1) return new Response("old", { status: 200 });
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com"); // prime "old"
    const forced = await executor.fetch("https://example.com", { noCache: true });
    expect(forced.ok).toBe(false);

    const followUp = await executor.fetch("https://example.com");
    // Follow-up call must have hit origin (and failed again), not served
    // the stale "old" value that was explicitly forced out.
    expect(callCount).toBe(3);
    expect(followUp.ok).toBe(false);
  });

  test("concurrent default reader during noCache refresh does not see stale entry", async () => {
    // Regression for #1903 review round 4: while a `noCache` fetch is in
    // flight the pre-existing entry must be hidden from default readers
    // so they cannot race in and be served a known-to-be-revalidating
    // stale body. The saved entry is restored only when the refresh
    // fails to reach origin.
    let callCount = 0;
    let signalRefreshInFlight: (() => void) | undefined;
    let releaseRefresh: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshInFlight = resolve;
    });
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchFn = mock(async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) return new Response("old", { status: 200 });
      if (callCount === 2) {
        signalRefreshInFlight?.();
        await refreshHeld;
        return new Response("new", { status: 200 });
      }
      // Concurrent reader during in-flight refresh — resolves immediately.
      return new Response("concurrent-fresh", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com"); // prime "old"

    const refreshP = executor.fetch("https://example.com", { noCache: true });
    await refreshStarted;
    // Concurrent default reader arrives while refresh is in flight — must
    // not be served the pre-existing "old" entry.
    const concurrent = await executor.fetch("https://example.com");
    if (concurrent.ok) expect(concurrent.value.cached).toBe(false);
    expect(callCount).toBeGreaterThanOrEqual(2);

    releaseRefresh?.();
    await refreshP;
  });

  // -------------------------------------------------------------------------
  // Origin freshness directives are honored (#1903 review round 4)
  // -------------------------------------------------------------------------

  test("does not cache responses with Cache-Control: max-age=0", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("fresh", {
        status: 200,
        headers: { "cache-control": "public, max-age=0" },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });
    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("does not cache responses with Cache-Control: must-revalidate", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("fresh", {
        status: 200,
        headers: { "cache-control": "public, must-revalidate, max-age=60" },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });
    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("does not cache responses with Pragma: no-cache", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("fresh", {
        status: 200,
        headers: { pragma: "no-cache" },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });
    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("does not cache responses with an Expires date in the past", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("stale", {
        status: 200,
        headers: { expires: new Date(Date.now() - 3600_000).toUTCString() },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });
    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("still caches responses with a future Expires and no revalidation flag", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("cacheable", {
        status: 200,
        headers: { expires: new Date(Date.now() + 3600_000).toUTCString() },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });
    await executor.fetch("https://example.com");
    const second = await executor.fetch("https://example.com");
    expect(callCount).toBe(1);
    if (second.ok) expect(second.value.cached).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Per-entry TTL — origin freshness caps the cache lifetime (#1903 round 5)
  // -------------------------------------------------------------------------

  test("caps entry lifetime to Cache-Control: max-age when shorter than default TTL", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("short-lived", {
        status: 200,
        headers: { "cache-control": "public, max-age=1" },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(1); // still within 1s — cache hit

    // Wait past origin's 1s freshness budget. Entry must expire even
    // though the global TTL is 60s.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("subtracts Age header from max-age when capping the entry TTL", async () => {
    // Regression for #1903 review round 7: TTL capping must use remaining
    // freshness (max-age - Age), not nominal freshness. A response with
    // max-age=10 and Age=9 has one second of life left, not ten.
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("almost-stale-upstream", {
        status: 200,
        headers: { "cache-control": "public, max-age=10", age: "9" },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("refuses to cache responses that arrive already stale (Age >= max-age)", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("already-stale", {
        status: 200,
        headers: { "cache-control": "public, max-age=5", age: "6" },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("does not cache responses with Vary: * (representation not reusable)", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("body", {
        status: 200,
        headers: { vary: "*" },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("does not cache responses with any non-empty Vary (conservative key bypass)", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("encoded", {
        status: 200,
        headers: { vary: "Accept-Encoding" },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com");
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("ignores s-maxage (this is a private end-cache, not a shared one)", async () => {
    // Regression for #1903 review round 8: `s-maxage` is defined for
    // shared caches only. This executor's LRU is per-process/private,
    // so a response like `max-age=60, s-maxage=3600` must expire at 60s
    // (the end-client budget), never the 3600s shared-cache budget.
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("body", {
        status: 200,
        headers: { "cache-control": "public, max-age=1, s-maxage=3600" },
      });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
  });

  test("does not alias GET requests that differ by body", async () => {
    // Regression for #1903 review round 8: GET-with-body is unusual but
    // permitted by the executor contract. Two GETs to the same URL with
    // different bodies are logically distinct requests and must never
    // read the same cache entry.
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response(`call-${callCount}`, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    const first = await executor.fetch("https://example.com", { body: "payload-a" });
    const second = await executor.fetch("https://example.com", { body: "payload-b" });
    expect(callCount).toBe(2);
    if (first.ok) expect(first.value.cached).toBe(false);
    if (second.ok) expect(second.value.cached).toBe(false);
  });

  test("failed noCache after a preceding default miss: pre-refresh default cannot repopulate", async () => {
    // Regression for #1903 post-merge review round 7: a default GET
    // miss starts first and is still in flight. A noCache arrives,
    // bumps the generation, evicts, then fails. The generation/
    // in-flight bookkeeping must survive long enough that the older
    // default's late write is still refused — otherwise an eager
    // prune would let the pre-refresh default silently repopulate the
    // cache with stale content after an explicit forced-fresh failed.
    let callCount = 0;
    let releaseDefault: (() => void) | undefined;
    const defaultHeld = new Promise<void>((resolve) => {
      releaseDefault = resolve;
    });
    const fetchFn = mock(async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        await defaultHeld;
        return new Response("v-default-stale", { status: 200 });
      }
      if (callCount === 2) throw new Error("origin down");
      return new Response("v-followup", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    const defaultP = executor.fetch("https://example.com");
    await Promise.resolve();

    // noCache fires, bumps generation, attempts refresh, throws.
    const forced = await executor.fetch("https://example.com", { noCache: true });
    expect(forced.ok).toBe(false);

    // Release the earlier default. Its captured generation is now
    // stale; its write MUST be refused.
    releaseDefault?.();
    await defaultP;

    // Cache must still be empty.
    const followUp = await executor.fetch("https://example.com");
    if (followUp.ok) expect(followUp.value.cached).toBe(false);
    expect(callCount).toBe(3);
  });

  test("default miss starts before noCache: default's late write is superseded by refresh", async () => {
    // Regression for #1903 post-merge review round 5: a default GET miss
    // starts first and holds the write fence. A later `noCache` call
    // arrives, evicts the cache, and bumps the per-key generation. When
    // the earlier default finally returns, its captured generation is
    // stale — its write-back MUST be refused, otherwise the forced
    // refresh's invalidation would be silently rolled back to the
    // older concurrent response and stay stale for the full TTL.
    let callCount = 0;
    let releaseDefault: (() => void) | undefined;
    const defaultHeld = new Promise<void>((resolve) => {
      releaseDefault = resolve;
    });
    const fetchFn = mock(async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        // Default miss — holds until we release.
        await defaultHeld;
        return new Response("v-default-stale", { status: 200 });
      }
      if (callCount === 2) {
        // noCache refresh — responds promptly with fresh body.
        return new Response("v-refresh-fresh", { status: 200 });
      }
      return new Response("v-followup", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    // Default miss starts first and stalls on `defaultHeld`.
    const defaultP = executor.fetch("https://example.com");

    // Brief yield so the default request is definitely in flight.
    await Promise.resolve();

    // noCache fires now, evicts cache, bumps generation, fetches fresh.
    const refresh = await executor.fetch("https://example.com", { noCache: true });
    expect(refresh.ok).toBe(true);

    // Now release the default. Its write-back must be refused because
    // the noCache bump invalidated its captured generation.
    releaseDefault?.();
    await defaultP;

    // Cache holds the refresh's body, not the default's late arrival.
    const followUp = await executor.fetch("https://example.com");
    if (followUp.ok) {
      expect(followUp.value.body).toBe("v-refresh-fresh");
      expect(followUp.value.cached).toBe(true);
    }
  });

  test("stuck body read aborts on timeout — singleFlight does not blackhole the key", async () => {
    // Regression for #1903 post-merge review round 10: if the primary
    // fetch returns headers but the body stream never resolves, the
    // request timeout MUST still fire and release the single-flight
    // slot. Otherwise later callers would each join the zombie entry,
    // time out locally, and the poisoned slot would persist for the
    // process lifetime — a process-long DoS on the key.
    let callCount = 0;
    const fetchFn = mock(async (_url: string, init?: RequestInit): Promise<Response> => {
      callCount++;
      // Wrap the body in a stream that never resolves unless aborted.
      const stream = new ReadableStream({
        start(controller) {
          const signal = init?.signal;
          if (signal !== null && signal !== undefined) {
            signal.addEventListener(
              "abort",
              () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          }
          // Otherwise: never enqueue, never close.
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({
      fetchFn,
      cacheTtlMs: 60_000,
      defaultTimeoutMs: 150,
      ...HTTPS_DEFAULTS,
    });

    const first = await executor.fetch("https://example.com");
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("TIMEOUT");

    // The single-flight slot for the first request must have been
    // released. A second fetch should start a fresh origin request,
    // not join a zombie entry.
    const second = await executor.fetch("https://example.com");
    expect(callCount).toBe(2);
    expect(second.ok).toBe(false);
  });

  test("single-flight waiter honors its own timeoutMs, not the primary's", async () => {
    // Regression for #1903 post-merge review round 9: a second caller
    // that joins an in-flight request must still time out on its own
    // budget, not the primary's. Otherwise a short-deadline follower
    // can hang behind a long-running primary.
    let releaseOrigin: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseOrigin = resolve;
    });
    const fetchFn = mock(async (): Promise<Response> => {
      await held;
      return new Response("slow", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    // Primary fetch starts with a long default timeout.
    const primary = executor.fetch("https://example.com");
    await Promise.resolve();

    // Follower with a 100 ms budget — must NOT wait for the primary.
    const followerStart = Date.now();
    const follower = await executor.fetch("https://example.com", { timeoutMs: 100 });
    const elapsed = Date.now() - followerStart;

    expect(elapsed).toBeLessThan(1000);
    expect(follower.ok).toBe(false);
    if (!follower.ok) expect(follower.error.code).toBe("TIMEOUT");

    // Cleanup: let the primary complete.
    releaseOrigin?.();
    await primary;
  });

  test("single-flight waiter honors its own abort signal", async () => {
    // Regression for #1903 post-merge review round 9: a waiter that
    // aborts its own signal should return immediately, independent of
    // the still-in-flight primary request.
    let releaseOrigin: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseOrigin = resolve;
    });
    const fetchFn = mock(async (): Promise<Response> => {
      await held;
      return new Response("slow", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    const primary = executor.fetch("https://example.com");
    await Promise.resolve();

    const followerController = new AbortController();
    const followerP = executor.fetch("https://example.com", {
      signal: followerController.signal,
    });
    // Yield once so the follower actually registers on the shared promise,
    // then abort.
    await Promise.resolve();
    followerController.abort();

    const follower = await followerP;
    expect(follower.ok).toBe(false);
    if (!follower.ok) expect(follower.error.code).toBe("TIMEOUT");

    releaseOrigin?.();
    await primary;
  });

  test("single-flight: concurrent default misses share one origin fetch", async () => {
    // Regression for #1903 post-merge review round 8: the CDN-skew
    // concern where two concurrent misses return different
    // representations is mitigated by request coalescing. A second
    // default caller that arrives while an identical default is still
    // in flight piggybacks on the shared promise instead of issuing
    // its own origin hit — so there is at most one live network
    // request per key per refresh cycle, and the divergent-response
    // scenario literally cannot happen.
    let callCount = 0;
    let releaseOrigin: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseOrigin = resolve;
    });
    const fetchFn = mock(async (): Promise<Response> => {
      callCount++;
      await held;
      return new Response("shared-body", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    const first = executor.fetch("https://example.com");
    // Yield so `first` actually registers its single-flight slot.
    await Promise.resolve();
    const second = executor.fetch("https://example.com");

    releaseOrigin?.();
    const [r1, r2] = await Promise.all([first, second]);

    expect(callCount).toBe(1);
    if (r1.ok) expect(r1.value.body).toBe("shared-body");
    if (r2.ok) expect(r2.value.body).toBe("shared-body");
  });

  test("stale-fast / fresh-slow race: only first-in-flight writes (no backwards rollback)", async () => {
    // Regression for #1903 review round 3 of post-merge loop: arrival
    // order is not a reliable freshness signal under CDN/blue-green
    // skew. Single-flight write-token guarantees that only the FIRST
    // concurrent miss writes to the cache — the second fetch completes
    // but skips the write. That rules out both rollback ordering bugs
    // (stale-fast beats fresh-slow AND fresh-fast beats stale-slow).
    let callCount = 0;
    let releaseStaleFast: (() => void) | undefined;
    let releaseFreshSlow: (() => void) | undefined;
    const staleReady = new Promise<void>((r) => {
      releaseStaleFast = r;
    });
    const freshReady = new Promise<void>((r) => {
      releaseFreshSlow = r;
    });
    const fetchFn = mock(async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        await staleReady;
        return new Response("stale-edge-v0", { status: 200 });
      }
      await freshReady;
      return new Response("fresh-edge-v1", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    const staleP = executor.fetch("https://example.com");
    const freshP = executor.fetch("https://example.com");

    // Stale edge returns first — it holds the write token, writes.
    releaseStaleFast?.();
    await staleP;

    // Fresh edge returns after — no write token, MUST NOT overwrite.
    releaseFreshSlow?.();
    await freshP;

    // Cache holds whatever the first writer put in (stale-edge-v0 here);
    // the test's point is that later writers can't rewrite the key,
    // not that we picked the "right" body (we have no way to tell).
    const followUp = await executor.fetch("https://example.com");
    if (followUp.ok) {
      expect(followUp.value.cached).toBe(true);
      expect(followUp.value.body).toBe("stale-edge-v0");
    }
  });

  test("slower default fetch does not overwrite a faster peer's cache write", async () => {
    // Regression for #1903 review round 11: two concurrent default GETs
    // both miss an empty cache and fetch from origin. If they complete
    // out of order, the slower response must NOT overwrite the faster
    // one — without an ETag/Last-Modified compare we cannot tell which
    // edge's response is actually "newer", so first-writer-wins is the
    // safe invariant. Otherwise a stale CDN edge can roll the cache
    // backwards for the full TTL after a fresher edge already populated
    // it.
    let callCount = 0;
    let releaseFast: (() => void) | undefined;
    let releaseSlow: (() => void) | undefined;
    const fastReady = new Promise<void>((resolve) => {
      releaseFast = resolve;
    });
    const slowReady = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const fetchFn = mock(async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        // Fast (fresh-edge) request — resolves first once we release it.
        await fastReady;
        return new Response("fresh-edge-v2", { status: 200 });
      }
      // Slow (stale-edge) request — resolves after the fast one.
      await slowReady;
      return new Response("stale-edge-v1", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    // Kick off both fetches concurrently. Both miss cache.
    const fastP = executor.fetch("https://example.com");
    const slowP = executor.fetch("https://example.com");

    // Release the fast request first. Its response lands and populates
    // the cache before the slow one even begins to return.
    releaseFast?.();
    await fastP;

    // Now release the slow one. Under the buggy "last-writer-wins"
    // default, it would overwrite the cache with "stale-edge-v1".
    releaseSlow?.();
    await slowP;

    const followUp = await executor.fetch("https://example.com");
    if (followUp.ok) {
      expect(followUp.value.body).toBe("fresh-edge-v2");
      expect(followUp.value.cached).toBe(true);
    }
  });

  test("noCache with custom headers fences concurrent default writers during the refresh", async () => {
    // Regression for #1903 review round 4 of post-merge loop: when a
    // forced-refresh carries custom headers (auth, Accept, Range, etc.)
    // its OWN request is uncacheable, but it still needs to claim the
    // per-key write fence. Otherwise a concurrent default GET could
    // miss cache during the refresh RTT, fetch origin, and repopulate
    // the default key with a stale representation — undoing the
    // invalidation the forced-refresh caller just performed.
    let callCount = 0;
    let signalRefreshStarted: (() => void) | undefined;
    let releaseRefresh: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchFn = mock(async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) return new Response("v1-stale", { status: 200 });
      if (callCount === 2) {
        // The authenticated noCache refresh.
        signalRefreshStarted?.();
        await refreshHeld;
        return new Response("v2-authed-live", { status: 200 });
      }
      // Concurrent default reader during the refresh.
      return new Response("v-concurrent-stale", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com"); // primes "v1-stale"

    const refreshP = executor.fetch("https://example.com", {
      headers: { Authorization: "Bearer abc" },
      noCache: true,
    });
    await refreshStarted;

    // Default reader during the refresh — must not repopulate the cache.
    await executor.fetch("https://example.com");

    releaseRefresh?.();
    await refreshP;

    // Refresh was uncacheable (custom headers) + concurrent reader was
    // fenced out. Cache remains empty so the next default fetch hits
    // origin rather than replaying the stale body the refresh invalidated.
    const followUp = await executor.fetch("https://example.com");
    if (followUp.ok) expect(followUp.value.cached).toBe(false);
  });

  test("noCache HEAD invalidates the cached GET body for the same URL", async () => {
    // Regression for #1903 review round 6 of post-merge loop: GET and
    // HEAD describe the same resource state for caching (HEAD = GET
    // headers minus body), so a forced-fresh HEAD must invalidate the
    // cached GET body, and vice versa. A caller that HEADs to verify
    // freshness and then GETs to read the content should not be
    // served the pre-refresh stale body.
    let callCount = 0;
    const fetchFn = mock(async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) return new Response("v1-stale", { status: 200 });
      if (callCount === 2) return new Response("", { status: 200 });
      return new Response("v2-fresh", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    // Prime with a default GET — caches v1-stale at GET:url.
    await executor.fetch("https://example.com");

    // Forced-fresh HEAD. Invalidates the peer GET cache entry.
    await executor.fetch("https://example.com", { method: "HEAD", noCache: true });

    // Default GET must now hit origin, not replay v1-stale.
    const followUp = await executor.fetch("https://example.com");
    expect(callCount).toBe(3);
    if (followUp.ok) {
      expect(followUp.value.body).toBe("v2-fresh");
      expect(followUp.value.cached).toBe(false);
    }
  });

  test("noCache with custom headers still evicts the prior default cached entry", async () => {
    // Regression for #1903 review round 11: `noCache` must invalidate
    // any pre-existing default cache entry at the `METHOD:URL` key even
    // when the forced-fresh request itself is uncacheable (custom
    // headers, request body). Otherwise a caller does a forced refresh
    // with auth headers, sees new content, and the very next default
    // fetch still serves the stale pre-refresh body.
    let callCount = 0;
    const fetchFn = mock(async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) return new Response("v1-stale", { status: 200 });
      if (callCount === 2) return new Response("v2-live-with-headers", { status: 200 });
      return new Response("v3-from-origin", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    // Prime with a default GET — caches "v1-stale" at GET:url.
    await executor.fetch("https://example.com");

    // Forced refresh with custom headers. The request itself is not
    // cacheable (headers rewrite the representation), but the caller
    // explicitly set `noCache`, so the old entry at GET:url must go.
    const forced = await executor.fetch("https://example.com", {
      headers: { Authorization: "Bearer abc" },
      noCache: true,
    });
    expect(forced.ok).toBe(true);

    // Default fetch must now hit origin, not replay the stale "v1".
    const followUp = await executor.fetch("https://example.com");
    expect(callCount).toBe(3);
    if (followUp.ok) {
      expect(followUp.value.body).toBe("v3-from-origin");
      expect(followUp.value.cached).toBe(false);
    }
  });

  test("noCache holds the write token: concurrent default readers fetch but cannot cache", async () => {
    // Single-flight semantics (#1903 round 3 of post-merge loop): when
    // `noCache` is in flight it holds the per-key write token, so a
    // concurrent default reader arriving during the refresh RTT misses
    // cache, fetches live, returns that live body to its caller, but
    // does NOT populate the cache. When `noCache` finishes, its
    // response is the authoritative cache state for this refresh
    // cycle. This is intentional: without ETag/Last-Modified we have
    // no basis to pick between concurrent responses, and making the
    // explicit refresher authoritative is the cleanest contract.
    let callCount = 0;
    let signalRefreshStarted: (() => void) | undefined;
    let releaseRefresh: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchFn = mock(async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) return new Response("v1-prime", { status: 200 });
      if (callCount === 2) {
        signalRefreshStarted?.();
        await refreshHeld;
        return new Response("v2-from-refresh", { status: 200 });
      }
      return new Response("v3-concurrent-reader", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com"); // prime v1
    const refreshP = executor.fetch("https://example.com", { noCache: true });
    await refreshStarted;

    // Concurrent default reader — misses cache (noCache evicted), hits
    // origin live, gets v3. Returns v3 to its caller BUT does not
    // write to cache (noCache holds the token).
    const concurrent = await executor.fetch("https://example.com");
    if (concurrent.ok) {
      expect(concurrent.value.body).toBe("v3-concurrent-reader");
      expect(concurrent.value.cached).toBe(false);
    }

    releaseRefresh?.();
    await refreshP;

    // The refresh's body is what the cache holds — the noCache caller
    // is the authoritative refresher for this cycle.
    const followUp = await executor.fetch("https://example.com");
    if (followUp.ok) {
      expect(followUp.value.body).toBe("v2-from-refresh");
      expect(followUp.value.cached).toBe(true);
    }
  });

  test("failed noCache refresh: cache stays empty even after concurrent default reader runs", async () => {
    // Single-flight variant of the failed-refresh path: while `noCache`
    // is in flight it holds the write token. A concurrent default reader
    // during the refresh RTT fetches live but does not cache. When the
    // refresh then fails, the key is still empty — neither the noCache
    // caller nor the concurrent reader wrote anything. The next default
    // fetch hits origin again, which is exactly the "no stale fallback"
    // contract.
    let callCount = 0;
    let signalRefreshStarted: (() => void) | undefined;
    let releaseRefresh: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchFn = mock(async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) return new Response("old", { status: 200 });
      if (callCount === 2) {
        signalRefreshStarted?.();
        await refreshHeld;
        throw new Error("network down");
      }
      return new Response("concurrent-live", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    await executor.fetch("https://example.com"); // primes "old"

    const refreshP = executor.fetch("https://example.com", { noCache: true });
    await refreshStarted;
    const concurrent = await executor.fetch("https://example.com");
    if (concurrent.ok) {
      expect(concurrent.value.body).toBe("concurrent-live");
      expect(concurrent.value.cached).toBe(false);
    }

    releaseRefresh?.();
    const forced = await refreshP;
    expect(forced.ok).toBe(false);

    // Key must be empty — the refresh failed and the concurrent reader
    // didn't have the write token, so no one populated the cache.
    const followUp = await executor.fetch("https://example.com");
    if (followUp.ok) expect(followUp.value.cached).toBe(false);
    expect(callCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// search — SearchProvider interface
// ---------------------------------------------------------------------------

describe("createWebExecutor.search", () => {
  test("returns VALIDATION when no searchProvider provided", async () => {
    const executor = createWebExecutor({ allowHttps: false });
    const result = await executor.search("test query");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("searchProvider");
    }
  });

  test("delegates to searchProvider.search", async () => {
    const searchResults = [{ title: "Result", url: "https://example.com", snippet: "A result" }];
    const searchProvider: SearchProvider = {
      name: "mock",
      search: mock(async () => ({
        ok: true as const,
        value: searchResults,
      })),
    };

    const executor = createWebExecutor({ searchProvider, allowHttps: false });
    const result = await executor.search("test");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.title).toBe("Result");
    }
  });

  test("wraps searchProvider exceptions as error", async () => {
    const searchProvider: SearchProvider = {
      name: "failing",
      search: async () => {
        throw new Error("Provider crashed");
      },
    };

    const executor = createWebExecutor({ searchProvider, allowHttps: false });
    const result = await executor.search("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Provider crashed");
    }
  });

  test("caches search results when searchCacheTtlMs > 0", async () => {
    let callCount = 0;
    const searchProvider: SearchProvider = {
      name: "mock",
      search: async () => {
        callCount++;
        return { ok: true as const, value: [{ title: "R", url: "https://r.com", snippet: "s" }] };
      },
    };

    const executor = createWebExecutor({
      searchProvider,
      searchCacheTtlMs: 60_000,
      allowHttps: false,
    });

    await executor.search("query");
    await executor.search("query");
    expect(callCount).toBe(1);
  });

  test("cacheTtlMs alone does NOT enable search caching (separate knob)", async () => {
    // Regression for #1903 review: fetch and search cache TTLs are
    // independent so enabling the response cache doesn't silently cache
    // search results under the same budget. Operators reasoning about
    // stale search need `searchCacheTtlMs` explicitly.
    let callCount = 0;
    const searchProvider: SearchProvider = {
      name: "mock",
      search: async () => {
        callCount++;
        return { ok: true as const, value: [{ title: "R", url: "https://r.com", snippet: "s" }] };
      },
    };

    const executor = createWebExecutor({
      searchProvider,
      cacheTtlMs: 60_000, // response-cache only
      allowHttps: false,
    });

    await executor.search("query");
    await executor.search("query");
    expect(callCount).toBe(2);
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

    const executor = createWebExecutor({
      searchProvider,
      searchCacheTtlMs: 60_000,
      allowHttps: false,
    });

    await executor.search("Hello World");
    await executor.search("hello world");
    await executor.search("  HELLO WORLD  ");
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HTTPS support (SSRF relies on URL check + DNS validation)
// ---------------------------------------------------------------------------

describe("createWebExecutor.fetch HTTPS", () => {
  test("blocks HTTPS by default (DNS rebinding TOCTOU)", async () => {
    const fetchFn = mock(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
    const executor = createWebExecutor({
      fetchFn,
      dnsResolver: mockDnsResolver,
      allowHttps: false,
    });

    const result = await executor.fetch("https://example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("allowHttps");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("allows HTTPS when explicitly opted in", async () => {
    const fetchFn = mock(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const executor = createWebExecutor({
      fetchFn,
      dnsResolver: mockDnsResolver,
      allowHttps: true,
    });

    const result = await executor.fetch("https://example.com");

    expect(result.ok).toBe(true);
  });

  test("blocks HTTPS URLs targeting private IPs even with allowHttps", async () => {
    const privateResolver: DnsResolverFn = async () => ["10.0.0.1"];
    const fetchFn = mock(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
    const executor = createWebExecutor({
      fetchFn,
      dnsResolver: privateResolver,
      allowHttps: true,
    });

    const result = await executor.fetch("https://evil.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("private/reserved");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("blocks HTTPS when allowHttps is false", async () => {
    const fetchFn = mock(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
    const executor = createWebExecutor({
      fetchFn,
      dnsResolver: mockDnsResolver,
      allowHttps: false,
    });

    const result = await executor.fetch("https://example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("allowHttps");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("blocks mixed-case HTTPS schemes (case-insensitive)", async () => {
    const fetchFn = mock(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
    const executor = createWebExecutor({
      fetchFn,
      dnsResolver: mockDnsResolver,
      allowHttps: false,
    });

    for (const scheme of ["HTTPS://", "Https://", "HtTpS://"]) {
      const result = await executor.fetch(`${scheme}example.com`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PERMISSION");
      }
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("allows HTTP when allowHttps is false", async () => {
    const fetchFn = mock(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const executor = createWebExecutor({
      fetchFn,
      dnsResolver: mockDnsResolver,
      allowHttps: false,
    });

    const result = await executor.fetch("http://example.com");

    expect(result.ok).toBe(true);
  });
});
