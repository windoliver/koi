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

  test("noCache=true bypasses both read and write", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      return new Response("fresh", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const executor = createWebExecutor({ fetchFn, cacheTtlMs: 60_000, ...HTTPS_DEFAULTS });

    // Prime the cache.
    await executor.fetch("https://example.com");
    // Forced-fresh: must hit network.
    const bypassed = await executor.fetch("https://example.com", { noCache: true });
    // Write was skipped, so a third default call must also hit network.
    const afterBypass = await executor.fetch("https://example.com", { noCache: true });
    expect(callCount).toBe(3);
    if (bypassed.ok) expect(bypassed.value.cached).toBe(false);
    if (afterBypass.ok) expect(afterBypass.value.cached).toBe(false);
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

  test("caches search results when cacheTtlMs > 0", async () => {
    let callCount = 0;
    const searchProvider: SearchProvider = {
      name: "mock",
      search: async () => {
        callCount++;
        return { ok: true as const, value: [{ title: "R", url: "https://r.com", snippet: "s" }] };
      },
    };

    const executor = createWebExecutor({ searchProvider, cacheTtlMs: 60_000, allowHttps: false });

    await executor.search("query");
    await executor.search("query");
    expect(callCount).toBe(1);
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

    const executor = createWebExecutor({ searchProvider, cacheTtlMs: 60_000, allowHttps: false });

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
