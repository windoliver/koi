import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fetchAgents, fetchMetrics } from "./api-client.js";

// Mock fetch globally for these tests
const originalFetch = globalThis.fetch;

function mockFetch(body: unknown, status = 200): void {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

beforeAll(() => {
  // Reset fetch
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchAgents", () => {
  test("returns agents on success", async () => {
    mockFetch({ ok: true, data: [{ agentId: "a1", name: "test" }] });
    const result = await fetchAgents();
    expect(result).toHaveLength(1);
    expect(result[0]?.agentId).toBe("a1");
  });

  test("throws on API error", async () => {
    mockFetch({ ok: false, error: { code: "INTERNAL", message: "Server error" } });
    await expect(fetchAgents()).rejects.toThrow("Server error");
  });
});

describe("fetchMetrics", () => {
  test("returns metrics on success", async () => {
    mockFetch({ ok: true, data: { uptimeMs: 1000, activeAgents: 3 } });
    const result = await fetchMetrics();
    expect(result.activeAgents).toBe(3);
  });
});
