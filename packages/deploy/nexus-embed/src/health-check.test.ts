import { describe, expect, test } from "bun:test";
import { pollHealth, probeHealth } from "./health-check.js";
import type { FetchFn } from "./types.js";

/** Create a mock fetch that returns a specific status code. */
function createMockFetch(status: number): FetchFn {
  return async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(null, { status });
}

/** Create a mock fetch that rejects (simulates connection refused). */
function createRejectingFetch(message = "Connection refused"): FetchFn {
  return async () => {
    throw new Error(message);
  };
}

/**
 * Create a mock fetch that fails N times then succeeds.
 * Useful for testing retry/poll behavior.
 */
function createEventualFetch(failCount: number): FetchFn {
  let calls = 0;
  return async (_input: string | URL | Request, _init?: RequestInit) => {
    calls += 1;
    if (calls <= failCount) {
      throw new Error("Connection refused");
    }
    return new Response(null, { status: 200 });
  };
}

describe("probeHealth", () => {
  test("returns true when fetch returns 200", async () => {
    const mockFetch = createMockFetch(200);
    const result = await probeHealth("http://127.0.0.1:2026", mockFetch);
    expect(result).toBe(true);
  });

  test("returns false when fetch throws (connection refused)", async () => {
    const mockFetch = createRejectingFetch();
    const result = await probeHealth("http://127.0.0.1:2026", mockFetch);
    expect(result).toBe(false);
  });

  test("returns false when fetch returns 500", async () => {
    const mockFetch = createMockFetch(500);
    const result = await probeHealth("http://127.0.0.1:2026", mockFetch);
    expect(result).toBe(false);
  });

  test("returns true for 204 (any 2xx is ok)", async () => {
    const mockFetch = createMockFetch(204);
    const result = await probeHealth("http://127.0.0.1:2026", mockFetch);
    expect(result).toBe(true);
  });

  test("calls the correct health URL", async () => {
    let calledUrl: string | undefined;
    const mockFetch: FetchFn = async (input: string | URL | Request, _init?: RequestInit) => {
      calledUrl = typeof input === "string" ? input : String(input);
      return new Response(null, { status: 200 });
    };
    await probeHealth("http://127.0.0.1:9999", mockFetch);
    expect(calledUrl).toBe("http://127.0.0.1:9999/health");
  });
});

describe("pollHealth", () => {
  test("succeeds on first attempt", async () => {
    const mockFetch = createMockFetch(200);
    const result = await pollHealth("http://127.0.0.1:2026", mockFetch);
    expect(result.ok).toBe(true);
  });

  test("succeeds after N failures then success", async () => {
    const mockFetch = createEventualFetch(3);
    const result = await pollHealth("http://127.0.0.1:2026", mockFetch);
    expect(result.ok).toBe(true);
  });

  test("returns TIMEOUT error when all attempts fail", async () => {
    const mockFetch = createRejectingFetch();
    // Use short timeout (500ms) to keep test fast
    const shortTimeout = 500;
    const start = Date.now();
    const result = await pollHealth("http://127.0.0.1:2026", mockFetch, shortTimeout);
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("timed out");
      expect(result.error.message).toContain(String(shortTimeout));
    }
    // Should have run for roughly the timeout duration
    expect(elapsed).toBeGreaterThanOrEqual(shortTimeout - 50);
    expect(elapsed).toBeLessThan(shortTimeout + 2000);
  });

  test("returns TIMEOUT error when server returns 500 repeatedly", async () => {
    const mockFetch = createMockFetch(500);
    // Use short timeout to keep test fast
    const result = await pollHealth("http://127.0.0.1:2026", mockFetch, 500);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });
});
