/**
 * Error mapper tests — HTTP status → KoiError codes + Retry-After parsing.
 */

import { describe, expect, test } from "bun:test";
import { mapHttpStatusToKoiCode, mapProviderError, parseRetryAfterMs } from "./error-mapper.js";

// ---------------------------------------------------------------------------
// mapHttpStatusToKoiCode
// ---------------------------------------------------------------------------

describe("mapHttpStatusToKoiCode", () => {
  test("401 → PERMISSION", () => {
    expect(mapHttpStatusToKoiCode(401)).toBe("PERMISSION");
  });

  test("403 → PERMISSION", () => {
    expect(mapHttpStatusToKoiCode(403)).toBe("PERMISSION");
  });

  test("429 → RATE_LIMIT", () => {
    expect(mapHttpStatusToKoiCode(429)).toBe("RATE_LIMIT");
  });

  test("408 → TIMEOUT", () => {
    expect(mapHttpStatusToKoiCode(408)).toBe("TIMEOUT");
  });

  test("504 → TIMEOUT", () => {
    expect(mapHttpStatusToKoiCode(504)).toBe("TIMEOUT");
  });

  test("404 → NOT_FOUND", () => {
    expect(mapHttpStatusToKoiCode(404)).toBe("NOT_FOUND");
  });

  test("409 → CONFLICT", () => {
    expect(mapHttpStatusToKoiCode(409)).toBe("CONFLICT");
  });

  test("500 → EXTERNAL", () => {
    expect(mapHttpStatusToKoiCode(500)).toBe("EXTERNAL");
  });

  test("502 → EXTERNAL", () => {
    expect(mapHttpStatusToKoiCode(502)).toBe("EXTERNAL");
  });

  test("503 → EXTERNAL", () => {
    expect(mapHttpStatusToKoiCode(503)).toBe("EXTERNAL");
  });

  test("unknown 4xx → EXTERNAL", () => {
    expect(mapHttpStatusToKoiCode(418)).toBe("EXTERNAL");
  });
});

// ---------------------------------------------------------------------------
// parseRetryAfterMs
// ---------------------------------------------------------------------------

describe("parseRetryAfterMs", () => {
  test("null header → undefined", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  test("numeric seconds → milliseconds", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
  });

  test("fractional seconds → rounded up", () => {
    expect(parseRetryAfterMs("1.5")).toBe(1500);
  });

  test("zero seconds → 0ms", () => {
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  test("HTTP-date in future → positive ms", () => {
    const futureDate = new Date(Date.now() + 60_000).toUTCString();
    const result = parseRetryAfterMs(futureDate);
    expect(result).toBeDefined();
    // Should be roughly 60s (allow 5s tolerance)
    expect(result!).toBeGreaterThan(55_000);
    expect(result!).toBeLessThanOrEqual(61_000);
  });

  test("HTTP-date in past → 0ms", () => {
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(pastDate)).toBe(0);
  });

  test("garbage string → undefined", () => {
    expect(parseRetryAfterMs("not-a-number-or-date")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapProviderError
// ---------------------------------------------------------------------------

describe("mapProviderError", () => {
  test("429 with JSON error body", () => {
    const body = JSON.stringify({
      error: { message: "Rate limit exceeded", type: "rate_limit_error" },
    });
    const headers = new Headers({ "retry-after": "10" });
    const error = mapProviderError(429, body, headers, "API call failed");

    expect(error.code).toBe("RATE_LIMIT");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(10_000);
    expect(error.message).toContain("Rate limit exceeded");
  });

  test("401 with JSON error body", () => {
    const body = JSON.stringify({
      error: { message: "Invalid API key" },
    });
    const error = mapProviderError(401, body, new Headers(), "Auth failed");

    expect(error.code).toBe("PERMISSION");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("Invalid API key");
  });

  test("500 with plain text body", () => {
    const error = mapProviderError(500, "Internal Server Error", new Headers(), "Server error");

    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("Internal Server Error");
  });

  test("429 without Retry-After header", () => {
    const body = JSON.stringify({ error: "Too many requests" });
    const error = mapProviderError(429, body, new Headers(), "Rate limited");

    expect(error.code).toBe("RATE_LIMIT");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBeUndefined();
  });

  test("error body with string error field", () => {
    const body = JSON.stringify({ error: "Something went wrong" });
    const error = mapProviderError(500, body, new Headers(), "Oops");

    expect(error.message).toContain("Something went wrong");
  });
});
