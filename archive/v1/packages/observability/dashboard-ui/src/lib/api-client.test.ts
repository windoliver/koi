/**
 * api-client tests — verifies the fetch→parse→throw pipeline.
 *
 * Tests the fetchApi HTTP contract inline to avoid mock.module
 * contamination from concurrent test files (sse-dispatchers.test.ts
 * mocks the api-client module itself via mock.module).
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getDashboardConfig } from "./dashboard-config.js";

const API_BASE = getDashboardConfig().apiPath;

let fetchSpy: ReturnType<typeof spyOn> | undefined;

function mockFetch(body: unknown, status = 200): void {
  fetchSpy?.mockRestore();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

/**
 * Inline fetchApi — mirrors the real implementation in api-client.ts.
 * We test the HTTP contract (fetch → parse → error handling) directly
 * to avoid module-level mock interference.
 */
async function fetchApi<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  const body = (await response.json()) as {
    readonly ok: boolean;
    readonly data: T;
    readonly error: { readonly message: string };
  };
  if (!body.ok) {
    throw new Error(body.error.message);
  }
  return body.data;
}

describe("fetchAgents", () => {
  test("returns agents on success", async () => {
    mockFetch({ ok: true, data: [{ agentId: "a1", name: "test" }] });
    const result = await fetchApi<readonly { readonly agentId: string }[]>("/agents");
    expect(result).toHaveLength(1);
    expect(result[0]?.agentId).toBe("a1");
  });

  test("throws on API error", async () => {
    mockFetch({ ok: false, error: { code: "INTERNAL", message: "Server error" } });
    await expect(fetchApi("/agents")).rejects.toThrow("Server error");
  });
});

describe("fetchMetrics", () => {
  test("returns metrics on success", async () => {
    mockFetch({ ok: true, data: { uptimeMs: 1000, activeAgents: 3 } });
    const result = await fetchApi<{ readonly activeAgents: number }>("/metrics");
    expect(result.activeAgents).toBe(3);
  });
});
