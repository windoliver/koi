import { describe, expect, test } from "bun:test";
import {
  conflict,
  external,
  internal,
  notFound,
  permission,
  rateLimit,
  timeout,
  validation,
} from "./error-factories.js";

describe("error factories", () => {
  test("notFound returns NOT_FOUND error with resourceId context", () => {
    const err = notFound("user-123");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Not found: user-123");
    expect(err.retryable).toBe(false);
    expect(err.context).toEqual({ resourceId: "user-123" });
  });

  test("notFound accepts custom message", () => {
    const err = notFound("agent-1", "Agent not found: agent-1");
    expect(err.message).toBe("Agent not found: agent-1");
    expect(err.context).toEqual({ resourceId: "agent-1" });
  });

  test("conflict returns CONFLICT error with resourceId context", () => {
    const err = conflict("artifact-42");
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("Already exists: artifact-42");
    expect(err.retryable).toBe(true);
    expect(err.context).toEqual({ resourceId: "artifact-42" });
  });

  test("conflict accepts custom message", () => {
    const err = conflict("session-1", "Session already active: session-1");
    expect(err.message).toBe("Session already active: session-1");
  });

  test("validation returns VALIDATION error", () => {
    const err = validation("ID must not be empty");
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toBe("ID must not be empty");
    expect(err.retryable).toBe(false);
    expect(err.context).toBeUndefined();
  });

  test("internal returns INTERNAL error with optional cause", () => {
    const cause = new Error("disk full");
    const err = internal("Failed to save checkpoint", cause);
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toBe("Failed to save checkpoint");
    expect(err.retryable).toBe(false);
    expect(err.cause).toBe(cause);
  });

  test("internal without cause omits it", () => {
    const err = internal("Unexpected state");
    expect(err.cause).toBeUndefined();
  });

  test("rateLimit returns RATE_LIMIT error with optional context", () => {
    const err = rateLimit("Too many agents", { current: 50, max: 50 });
    expect(err.code).toBe("RATE_LIMIT");
    expect(err.message).toBe("Too many agents");
    expect(err.retryable).toBe(true);
    expect(err.context).toEqual({ current: 50, max: 50 });
  });

  test("timeout returns TIMEOUT error", () => {
    const err = timeout("Operation exceeded 30s deadline");
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toBe("Operation exceeded 30s deadline");
    expect(err.retryable).toBe(true);
  });

  test("external returns EXTERNAL error with optional cause", () => {
    const cause = new Error("connection refused");
    const err = external("LLM provider unavailable", cause);
    expect(err.code).toBe("EXTERNAL");
    expect(err.message).toBe("LLM provider unavailable");
    expect(err.retryable).toBe(false);
    expect(err.cause).toBe(cause);
  });

  test("permission returns PERMISSION error", () => {
    const err = permission("Access denied to tool: bash");
    expect(err.code).toBe("PERMISSION");
    expect(err.message).toBe("Access denied to tool: bash");
    expect(err.retryable).toBe(false);
  });

  test("all factories return readonly-compatible KoiError objects", () => {
    const errors = [
      notFound("x"),
      conflict("x"),
      validation("x"),
      internal("x"),
      rateLimit("x"),
      timeout("x"),
      external("x"),
      permission("x"),
    ];
    for (const err of errors) {
      expect(err).toHaveProperty("code");
      expect(err).toHaveProperty("message");
      expect(err).toHaveProperty("retryable");
      expect(typeof err.code).toBe("string");
      expect(typeof err.message).toBe("string");
      expect(typeof err.retryable).toBe("boolean");
    }
  });
});
