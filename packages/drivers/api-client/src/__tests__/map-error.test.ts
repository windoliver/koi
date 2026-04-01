import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { mapAnthropicError, mapStatusToKoiCode } from "../map-error.js";

describe("mapStatusToKoiCode", () => {
  test("maps 401 to PERMISSION", () => {
    expect(mapStatusToKoiCode(401)).toBe("PERMISSION");
  });

  test("maps 403 to PERMISSION", () => {
    expect(mapStatusToKoiCode(403)).toBe("PERMISSION");
  });

  test("maps 404 to NOT_FOUND", () => {
    expect(mapStatusToKoiCode(404)).toBe("NOT_FOUND");
  });

  test("maps 429 to RATE_LIMIT", () => {
    expect(mapStatusToKoiCode(429)).toBe("RATE_LIMIT");
  });

  test("maps 529 to RATE_LIMIT", () => {
    expect(mapStatusToKoiCode(529)).toBe("RATE_LIMIT");
  });

  test("maps 408 to TIMEOUT", () => {
    expect(mapStatusToKoiCode(408)).toBe("TIMEOUT");
  });

  test("maps 504 to TIMEOUT", () => {
    expect(mapStatusToKoiCode(504)).toBe("TIMEOUT");
  });

  test("maps 500 to EXTERNAL", () => {
    expect(mapStatusToKoiCode(500)).toBe("EXTERNAL");
  });

  test("maps undefined to EXTERNAL", () => {
    expect(mapStatusToKoiCode(undefined)).toBe("EXTERNAL");
  });
});

/**
 * Create headers for SDK error constructors.
 * Bun's Headers type is structurally incompatible with the SDK's internal Headers type,
 * so we cast through unknown. Runtime behavior is identical.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-unknown
function sdkHeaders(init?: Record<string, string>): never {
  return new Headers(init) as never;
}

describe("mapAnthropicError", () => {
  test("maps SDK APIError to KoiRuntimeError", () => {
    const apiError = new Anthropic.APIError(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "Too many requests" } },
      "Too many requests",
      sdkHeaders(),
    );

    const result = mapAnthropicError(apiError);
    expect(result.code).toBe("RATE_LIMIT");
    expect(result.retryable).toBe(true);
    expect(result.context).toEqual({ statusCode: 429 });
  });

  test("maps SDK AuthenticationError", () => {
    const error = new Anthropic.AuthenticationError(
      401,
      { type: "error", error: { type: "authentication_error", message: "Invalid key" } },
      "Invalid key",
      sdkHeaders(),
    );

    const result = mapAnthropicError(error);
    expect(result.code).toBe("PERMISSION");
    expect(result.retryable).toBe(false);
  });

  test("maps SDK RateLimitError with retry-after header", () => {
    const error = new Anthropic.RateLimitError(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
      "Rate limited",
      sdkHeaders({ "retry-after": "30" }),
    );

    const result = mapAnthropicError(error);
    expect(result.code).toBe("RATE_LIMIT");
    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBe(30_000);
  });

  test("maps AbortError to TIMEOUT", () => {
    const error = new DOMException("The operation was aborted", "AbortError");

    const result = mapAnthropicError(error);
    expect(result.code).toBe("TIMEOUT");
    expect(result.retryable).toBe(false);
  });

  test("maps generic Error to EXTERNAL", () => {
    const error = new Error("Network failure");

    const result = mapAnthropicError(error);
    expect(result.code).toBe("EXTERNAL");
    expect(result.message).toContain("Network failure");
    expect(result.retryable).toBe(false);
  });

  test("maps non-Error values to EXTERNAL", () => {
    const result = mapAnthropicError("something went wrong");
    expect(result.code).toBe("EXTERNAL");
    expect(result.message).toContain("something went wrong");
  });
});
