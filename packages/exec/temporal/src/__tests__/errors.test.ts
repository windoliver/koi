import { describe, expect, test } from "bun:test";
import { mapKoiErrorToApplicationFailure, mapTemporalError } from "../errors.js";

describe("mapTemporalError", () => {
  test("unknown value → INTERNAL non-retryable", () => {
    const result = mapTemporalError("oops");
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("TimeoutFailure → TIMEOUT retryable", () => {
    const err = { name: "TimeoutFailure", message: "timed out" };
    const result = mapTemporalError(err);
    expect(result.code).toBe("TIMEOUT");
    expect(result.retryable).toBe(true);
  });

  test("CancelledFailure → EXTERNAL non-retryable", () => {
    const err = { name: "CancelledFailure", message: "cancelled" };
    const result = mapTemporalError(err);
    expect(result.code).toBe("EXTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("ApplicationFailure with nonRetryable=true → non-retryable", () => {
    const err = { name: "ApplicationFailure", message: "bad", nonRetryable: true };
    const result = mapTemporalError(err);
    expect(result.retryable).toBe(false);
  });

  test("ApplicationFailure with embedded KoiError round-trips correctly", () => {
    const koiErr = { code: "TIMEOUT" as const, message: "slow", retryable: true };
    const err = { name: "ApplicationFailure", message: "wrapped", details: [koiErr] };
    const result = mapTemporalError(err);
    expect(result).toEqual(koiErr);
  });

  test("ApplicationFailure with unknown code in embedded payload falls back to mapped error", () => {
    const badPayload = { code: "UNKNOWN_CODE", message: "bad", retryable: true };
    const err = { name: "ApplicationFailure", message: "wrapped", details: [badPayload] };
    const result = mapTemporalError(err);
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toBe("wrapped");
  });

  test("ApplicationFailure with non-boolean retryable in payload falls back to mapped error", () => {
    const badPayload = { code: "TIMEOUT", message: "slow", retryable: "yes" };
    const err = { name: "ApplicationFailure", message: "wrapped", details: [badPayload] };
    const result = mapTemporalError(err);
    expect(result.code).toBe("INTERNAL");
  });

  test("ServerFailure → INTERNAL retryable", () => {
    const err = { name: "ServerFailure", message: "server down" };
    const result = mapTemporalError(err);
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(true);
  });
});

describe("mapKoiErrorToApplicationFailure", () => {
  test("retryable error → nonRetryable=false", () => {
    const err = { code: "TIMEOUT" as const, message: "slow", retryable: true };
    const payload = mapKoiErrorToApplicationFailure(err);
    expect(payload.nonRetryable).toBe(false);
    expect(payload.type).toBe("TIMEOUT");
    expect(payload.details[0]).toEqual(err);
  });

  test("non-retryable error → nonRetryable=true", () => {
    const err = { code: "PERMISSION" as const, message: "no access", retryable: false };
    const payload = mapKoiErrorToApplicationFailure(err);
    expect(payload.nonRetryable).toBe(true);
  });

  test("round-trips through mapTemporalError", () => {
    const original = { code: "NOT_FOUND" as const, message: "missing", retryable: false };
    const payload = mapKoiErrorToApplicationFailure(original);
    const appFailure = {
      name: "ApplicationFailure",
      message: payload.message,
      details: payload.details,
    };
    const restored = mapTemporalError(appFailure);
    expect(restored).toEqual(original);
  });
});
