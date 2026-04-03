import { describe, expect, test } from "bun:test";
import {
  connectionTimeoutError,
  mapMcpError,
  notConnectedError,
  reconnectExhaustedError,
  serverStartError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// mapMcpError
// ---------------------------------------------------------------------------

describe("mapMcpError", () => {
  test("maps rate limit errors", () => {
    const error = mapMcpError(new Error("Rate limit exceeded"), "test-server");
    expect(error.code).toBe("RATE_LIMIT");
    expect(error.retryable).toBe(true);
    expect(error.context).toEqual({ serverName: "test-server" });
  });

  test("maps 429 status to rate limit", () => {
    const error = mapMcpError(new Error("HTTP 429"), "test-server");
    expect(error.code).toBe("RATE_LIMIT");
    expect(error.retryable).toBe(true);
  });

  test("maps too many requests to rate limit", () => {
    const error = mapMcpError(new Error("Too many requests"), "test-server");
    expect(error.code).toBe("RATE_LIMIT");
    expect(error.retryable).toBe(true);
  });

  test("maps timeout errors", () => {
    const error = mapMcpError(new Error("Request timeout"), "test-server");
    expect(error.code).toBe("TIMEOUT");
    expect(error.retryable).toBe(true);
  });

  test("maps ETIMEDOUT to timeout", () => {
    const error = mapMcpError(new Error("connect ETIMEDOUT"), "test-server");
    expect(error.code).toBe("TIMEOUT");
    expect(error.retryable).toBe(true);
  });

  test("maps connection closed to external retryable", () => {
    const error = mapMcpError(new Error("connection closed"), "test-server");
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(true);
  });

  test("maps connection reset to external retryable", () => {
    const error = mapMcpError(new Error("ECONNRESET"), "test-server");
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(true);
  });

  test("maps connection refused to external retryable", () => {
    const error = mapMcpError(new Error("ECONNREFUSED"), "test-server");
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(true);
  });

  test("maps socket hang up to external retryable", () => {
    const error = mapMcpError(new Error("socket hang up"), "test-server");
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(true);
  });

  test("maps unauthorized errors to permission", () => {
    const error = mapMcpError(new Error("Unauthorized"), "test-server");
    expect(error.code).toBe("PERMISSION");
    expect(error.retryable).toBe(false);
  });

  test("maps forbidden errors to permission", () => {
    const error = mapMcpError(new Error("Forbidden"), "test-server");
    expect(error.code).toBe("PERMISSION");
    expect(error.retryable).toBe(false);
  });

  test("maps not found errors", () => {
    const error = mapMcpError(new Error("Tool not found"), "test-server");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.retryable).toBe(false);
  });

  test("maps unknown tool errors", () => {
    const error = mapMcpError(new Error("unknown tool: foo"), "test-server");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.retryable).toBe(false);
  });

  test("maps validation errors", () => {
    const error = mapMcpError(new Error("Invalid input"), "test-server");
    expect(error.code).toBe("VALIDATION");
    expect(error.retryable).toBe(false);
  });

  test("falls back to EXTERNAL for unrecognized errors", () => {
    const error = mapMcpError(new Error("something weird happened"), "test-server");
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(false);
  });

  test("handles string errors", () => {
    const error = mapMcpError("timeout occurred", "test-server");
    expect(error.code).toBe("TIMEOUT");
    expect(error.cause).toBeUndefined();
  });

  test("handles non-Error, non-string errors", () => {
    const error = mapMcpError(42, "test-server");
    expect(error.code).toBe("EXTERNAL");
    expect(error.message).toContain("42");
    expect(error.cause).toBeUndefined();
  });

  test("preserves Error as cause", () => {
    const original = new Error("connection closed unexpectedly");
    const error = mapMcpError(original, "test-server");
    expect(error.cause).toBe(original);
  });

  test("includes server name in message", () => {
    const error = mapMcpError(new Error("boom"), "my-server");
    expect(error.message).toContain("my-server");
  });
});

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

describe("connectionTimeoutError", () => {
  test("creates timeout error with server name and timeout", () => {
    const error = connectionTimeoutError("test-server", 5000);
    expect(error.code).toBe("TIMEOUT");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("5000ms");
    expect(error.context).toEqual({ serverName: "test-server", timeoutMs: 5000 });
  });
});

describe("serverStartError", () => {
  test("creates external error from Error cause", () => {
    const cause = new Error("spawn ENOENT");
    const error = serverStartError("test-server", cause);
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("spawn ENOENT");
    expect(error.cause).toBe(cause);
  });

  test("creates external error from string cause", () => {
    const error = serverStartError("test-server", "process exited");
    expect(error.message).toContain("process exited");
    expect(error.cause).toBeUndefined();
  });
});

describe("notConnectedError", () => {
  test("creates retryable external error", () => {
    const error = notConnectedError("test-server");
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("not connected");
  });
});

describe("reconnectExhaustedError", () => {
  test("creates non-retryable external error with attempt count", () => {
    const error = reconnectExhaustedError("test-server", 3);
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("3 attempts");
    expect(error.context).toEqual({ serverName: "test-server", attempts: 3 });
  });
});
