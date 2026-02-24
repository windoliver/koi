import { describe, expect, test } from "bun:test";
import { deliverWebhook } from "./deliver.js";

function mockFetch(status: number, body: string = "", delay: number = 0): typeof fetch {
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }

    // Check if aborted
    const init = _init as RequestInit | undefined;
    if (init?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

function mockFetchError(error: Error): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

const defaultOptions = { timeoutMs: 5_000, maxResponseBodyBytes: 4096 };
const headers = {
  "webhook-id": "wh_test",
  "webhook-timestamp": "1700000000",
  "webhook-signature": "v1,test",
  "content-type": "application/json",
};

describe("deliverWebhook", () => {
  test("returns success for 2xx response", async () => {
    const result = await deliverWebhook(
      "https://example.com/hook",
      '{"kind":"session.started"}',
      headers,
      defaultOptions,
      mockFetch(200),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.statusCode).toBe(200);
      expect(typeof result.latencyMs).toBe("number");
    }
  });

  test("returns success for 202 Accepted", async () => {
    const result = await deliverWebhook(
      "https://example.com/hook",
      "{}",
      headers,
      defaultOptions,
      mockFetch(202),
    );

    expect(result.ok).toBe(true);
  });

  test("returns failure for 4xx response", async () => {
    const result = await deliverWebhook(
      "https://example.com/hook",
      "{}",
      headers,
      defaultOptions,
      mockFetch(400, "Bad Request"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(400);
      expect(result.error).toContain("400");
    }
  });

  test("returns failure for 5xx response", async () => {
    const result = await deliverWebhook(
      "https://example.com/hook",
      "{}",
      headers,
      defaultOptions,
      mockFetch(500, "Internal Server Error"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(500);
      expect(result.error).toContain("500");
    }
  });

  test("returns failure on timeout", async () => {
    const result = await deliverWebhook(
      "https://example.com/hook",
      "{}",
      headers,
      { timeoutMs: 10, maxResponseBodyBytes: 4096 },
      mockFetch(200, "", 100), // 100ms delay, 10ms timeout
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Timeout");
    }
  });

  test("returns failure on network error", async () => {
    const result = await deliverWebhook(
      "https://example.com/hook",
      "{}",
      headers,
      defaultOptions,
      mockFetchError(new TypeError("Failed to connect")),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Network error");
    }
  });

  test("limits response body for error diagnostics", async () => {
    const longBody = "x".repeat(10_000);
    const result = await deliverWebhook(
      "https://example.com/hook",
      "{}",
      headers,
      { timeoutMs: 5_000, maxResponseBodyBytes: 100 },
      mockFetch(400, longBody),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Error should contain truncated body
      expect(result.error.length).toBeLessThan(longBody.length);
    }
  });

  test("includes latencyMs in result", async () => {
    const result = await deliverWebhook(
      "https://example.com/hook",
      "{}",
      headers,
      defaultOptions,
      mockFetch(200),
    );

    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
