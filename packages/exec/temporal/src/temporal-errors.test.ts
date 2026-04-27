import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core";
import { mapKoiErrorToApplicationFailure, mapTemporalError } from "./temporal-errors.js";

describe("mapKoiErrorToApplicationFailure", () => {
  test("maps retryable KoiError to nonRetryable=false", () => {
    const error: KoiError = {
      code: "TIMEOUT",
      message: "LLM call timed out",
      retryable: true,
      context: { agentId: "agent-1" },
    };
    const result = mapKoiErrorToApplicationFailure(error);
    expect(result.nonRetryable).toBe(false);
    expect(result.type).toBe("KoiError:TIMEOUT");
    expect(result.message).toBe("LLM call timed out");
    expect(result.details).toEqual([error]);
  });

  test("maps non-retryable KoiError to nonRetryable=true", () => {
    const error: KoiError = { code: "NOT_FOUND", message: "Agent not found", retryable: false };
    const result = mapKoiErrorToApplicationFailure(error);
    expect(result.nonRetryable).toBe(true);
    expect(result.type).toBe("KoiError:NOT_FOUND");
  });

  test("preserves full error context in details", () => {
    const error: KoiError = {
      code: "INTERNAL",
      message: "Unexpected error",
      retryable: false,
      context: { foo: "bar", nested: { deep: true } },
    };
    const result = mapKoiErrorToApplicationFailure(error);
    expect(result.details[0]).toEqual(error);
  });
});

describe("mapTemporalError — TimeoutFailure", () => {
  test("maps TimeoutFailure to TIMEOUT code with retryable=true", () => {
    const result = mapTemporalError({ name: "TimeoutFailure", message: "Activity timed out" });
    expect(result.code).toBe("TIMEOUT");
    expect(result.retryable).toBe(true);
  });
});

describe("mapTemporalError — CancelledFailure", () => {
  test("maps CancelledFailure to EXTERNAL with retryable=false", () => {
    const result = mapTemporalError({
      name: "CancelledFailure",
      message: "Workflow cancelled",
    });
    expect(result.code).toBe("EXTERNAL");
    expect(result.retryable).toBe(false);
  });
});

describe("mapTemporalError — ApplicationFailure round-trip", () => {
  test("round-trips KoiError through ApplicationFailure", () => {
    const original: KoiError = {
      code: "RATE_LIMIT",
      message: "Too many requests",
      retryable: true,
      context: { retryAfterMs: 5000 },
    };
    const payload = mapKoiErrorToApplicationFailure(original);
    const result = mapTemporalError({
      name: "ApplicationFailure",
      message: payload.message,
      type: payload.type,
      nonRetryable: payload.nonRetryable,
      details: payload.details,
    });
    expect(result.code).toBe("RATE_LIMIT");
    expect(result.retryable).toBe(true);
    expect(result.context).toEqual({ retryAfterMs: 5000 });
  });

  test("ApplicationFailure without KoiError payload maps to INTERNAL", () => {
    const result = mapTemporalError({
      name: "ApplicationFailure",
      message: "Something broke",
      nonRetryable: true,
      details: [{ notAKoiError: true }],
    });
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("ApplicationFailure nonRetryable=false → retryable=true", () => {
    const result = mapTemporalError({
      name: "ApplicationFailure",
      message: "Transient error",
      nonRetryable: false,
      details: [],
    });
    expect(result.retryable).toBe(true);
  });
});

describe("mapTemporalError — TerminatedFailure", () => {
  test("maps TerminatedFailure to EXTERNAL with retryable=false", () => {
    const result = mapTemporalError({ name: "TerminatedFailure", message: "Workflow terminated" });
    expect(result.code).toBe("EXTERNAL");
    expect(result.retryable).toBe(false);
  });
});

describe("mapTemporalError — unknown errors", () => {
  test("maps plain Error to INTERNAL", () => {
    const result = mapTemporalError(new Error("plain error"));
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toBe("plain error");
    expect(result.retryable).toBe(false);
  });

  test("maps string to INTERNAL", () => {
    const result = mapTemporalError("string error");
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toBe("string error");
  });

  test("maps null to INTERNAL with fallback message", () => {
    const result = mapTemporalError(null);
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toBe("Unknown Temporal error");
  });

  test("maps undefined to INTERNAL with fallback message", () => {
    const result = mapTemporalError(undefined);
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toBe("Unknown Temporal error");
  });
});
