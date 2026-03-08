/**
 * Tests for Temporal ↔ KoiError bidirectional error mapping.
 * Decision 6A: Explicit mapping module at system boundary.
 */

import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core";
import { mapKoiErrorToApplicationFailure, mapTemporalError } from "./temporal-errors.js";

// ---------------------------------------------------------------------------
// mapKoiErrorToApplicationFailure
// ---------------------------------------------------------------------------

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
    const error: KoiError = {
      code: "NOT_FOUND",
      message: "Agent not found",
      retryable: false,
    };

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
    expect(result.details[0]?.context).toEqual({ foo: "bar", nested: { deep: true } });
  });
});

// ---------------------------------------------------------------------------
// mapTemporalError — TimeoutFailure
// ---------------------------------------------------------------------------

describe("mapTemporalError — TimeoutFailure", () => {
  test("maps TimeoutFailure to TIMEOUT code with retryable=true", () => {
    const temporalError = {
      name: "TimeoutFailure",
      message: "Activity timed out",
    };

    const result = mapTemporalError(temporalError);

    expect(result.code).toBe("TIMEOUT");
    expect(result.message).toBe("Activity timed out");
    expect(result.retryable).toBe(true);
    expect(result.context).toEqual({
      source: "temporal",
      temporalFailureType: "TimeoutFailure",
    });
  });
});

// ---------------------------------------------------------------------------
// mapTemporalError — CancelledFailure
// ---------------------------------------------------------------------------

describe("mapTemporalError — CancelledFailure", () => {
  test("maps CancelledFailure to CANCELLED code with retryable=false", () => {
    const temporalError = {
      name: "CancelledFailure",
      message: "Workflow cancelled by user",
    };

    const result = mapTemporalError(temporalError);

    expect(result.code).toBe("CANCELLED");
    expect(result.message).toBe("Workflow cancelled by user");
    expect(result.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapTemporalError — ApplicationFailure with embedded KoiError
// ---------------------------------------------------------------------------

describe("mapTemporalError — ApplicationFailure round-trip", () => {
  test("round-trips KoiError through ApplicationFailure", () => {
    const original: KoiError = {
      code: "RATE_LIMITED",
      message: "Too many requests",
      retryable: true,
      context: { retryAfterMs: 5000 },
    };

    // Simulate: KoiError → ApplicationFailure → Temporal wire → mapTemporalError
    const payload = mapKoiErrorToApplicationFailure(original);
    const temporalError = {
      name: "ApplicationFailure",
      message: payload.message,
      type: payload.type,
      nonRetryable: payload.nonRetryable,
      details: payload.details,
    };

    const result = mapTemporalError(temporalError);

    expect(result.code).toBe("RATE_LIMITED");
    expect(result.message).toBe("Too many requests");
    expect(result.retryable).toBe(true);
    expect(result.context).toEqual({ retryAfterMs: 5000 });
  });

  test("ApplicationFailure without KoiError payload maps to INTERNAL", () => {
    const temporalError = {
      name: "ApplicationFailure",
      message: "Something broke",
      nonRetryable: true,
      details: [{ notAKoiError: true }],
    };

    const result = mapTemporalError(temporalError);

    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("ApplicationFailure nonRetryable=false → retryable=true", () => {
    const temporalError = {
      name: "ApplicationFailure",
      message: "Transient error",
      nonRetryable: false,
      details: [],
    };

    const result = mapTemporalError(temporalError);

    expect(result.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mapTemporalError — TerminatedFailure
// ---------------------------------------------------------------------------

describe("mapTemporalError — TerminatedFailure", () => {
  test("maps TerminatedFailure to CANCELLED with retryable=false", () => {
    const temporalError = {
      name: "TerminatedFailure",
      message: "Workflow terminated",
    };

    const result = mapTemporalError(temporalError);

    expect(result.code).toBe("CANCELLED");
    expect(result.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapTemporalError — unknown errors
// ---------------------------------------------------------------------------

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
    expect(result.retryable).toBe(false);
  });

  test("maps null to INTERNAL with fallback message", () => {
    const result = mapTemporalError(null);

    expect(result.code).toBe("INTERNAL");
    expect(result.message).toBe("Unknown Temporal error");
    expect(result.retryable).toBe(false);
  });

  test("maps undefined to INTERNAL with fallback message", () => {
    const result = mapTemporalError(undefined);

    expect(result.code).toBe("INTERNAL");
    expect(result.message).toBe("Unknown Temporal error");
    expect(result.retryable).toBe(false);
  });
});
