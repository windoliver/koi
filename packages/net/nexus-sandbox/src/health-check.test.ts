import { describe, expect, test } from "bun:test";
import { pollHealth, probeHealth } from "./health-check.js";
import type { FetchFn } from "./types.js";

function mockFetch(status: number): FetchFn {
  return async () => new Response(null, { status });
}

function rejectingFetch(message = "Connection refused"): FetchFn {
  return async () => {
    throw new Error(message);
  };
}

function eventualFetch(failCount: number, finalStatus = 200): FetchFn {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= failCount) throw new Error("Connection refused");
    return new Response(null, { status: finalStatus });
  };
}

describe("probeHealth", () => {
  test("true on 200", async () => {
    expect(await probeHealth("http://127.0.0.1:2026", mockFetch(200))).toBe(true);
  });

  test("true on any 2xx", async () => {
    expect(await probeHealth("http://127.0.0.1:2026", mockFetch(204))).toBe(true);
  });

  test("false on 500", async () => {
    expect(await probeHealth("http://127.0.0.1:2026", mockFetch(500))).toBe(false);
  });

  test("false on connection refused", async () => {
    expect(await probeHealth("http://127.0.0.1:2026", rejectingFetch())).toBe(false);
  });

  test("hits /health on the base URL", async () => {
    let captured: string | undefined;
    const fetch: FetchFn = async (input) => {
      captured = typeof input === "string" ? input : String(input);
      return new Response(null, { status: 200 });
    };
    await probeHealth("http://127.0.0.1:9999", fetch);
    expect(captured).toBe("http://127.0.0.1:9999/health");
  });
});

describe("pollHealth", () => {
  test("ok on first try", async () => {
    const r = await pollHealth("http://127.0.0.1:2026", mockFetch(200));
    expect(r.ok).toBe(true);
  });

  test("ok after retries", async () => {
    const r = await pollHealth("http://127.0.0.1:2026", eventualFetch(3));
    expect(r.ok).toBe(true);
  });

  test("TIMEOUT when all probes reject", async () => {
    const start = Date.now();
    const r = await pollHealth("http://127.0.0.1:2026", rejectingFetch(), 300);
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TIMEOUT");
      expect(r.error.retryable).toBe(true);
      expect(r.error.message).toContain("health");
      expect(r.error.context).toMatchObject({ baseUrl: "http://127.0.0.1:2026" });
    }
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2000);
  });

  test("TIMEOUT when server keeps returning 500", async () => {
    const r = await pollHealth("http://127.0.0.1:2026", mockFetch(500), 300);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TIMEOUT");
  });
});
