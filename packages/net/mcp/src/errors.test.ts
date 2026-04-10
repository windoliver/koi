import { describe, expect, test } from "bun:test";
import {
  connectionTimeoutError,
  mapMcpError,
  notConnectedError,
  reconnectExhaustedError,
  sessionExpiredError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// mapMcpError — HTTP status codes (highest priority)
// ---------------------------------------------------------------------------

describe("mapMcpError with HTTP status", () => {
  test("maps 401 to AUTH_REQUIRED", () => {
    const err = mapMcpError(new Error("Unauthorized"), {
      serverName: "s1",
      httpStatus: 401,
    });
    expect(err.code).toBe("AUTH_REQUIRED");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("HTTP 401");
  });

  test("maps 403 to PERMISSION", () => {
    const err = mapMcpError(new Error("Forbidden"), {
      serverName: "s1",
      httpStatus: 403,
    });
    expect(err.code).toBe("PERMISSION");
    expect(err.retryable).toBe(false);
  });

  test("maps 404 to NOT_FOUND", () => {
    const err = mapMcpError(new Error("Not found"), {
      serverName: "s1",
      httpStatus: 404,
    });
    expect(err.code).toBe("NOT_FOUND");
    expect(err.retryable).toBe(false);
  });

  test("maps 429 to RATE_LIMIT (retryable)", () => {
    const err = mapMcpError(new Error("Too many requests"), {
      serverName: "s1",
      httpStatus: 429,
    });
    expect(err.code).toBe("RATE_LIMIT");
    expect(err.retryable).toBe(true);
  });

  test("maps 500 to EXTERNAL (retryable)", () => {
    const err = mapMcpError(new Error("Internal server error"), {
      serverName: "s1",
      httpStatus: 500,
    });
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(true);
  });

  test("maps 502 to EXTERNAL (retryable)", () => {
    const err = mapMcpError(new Error("Bad gateway"), {
      serverName: "s1",
      httpStatus: 502,
    });
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(true);
  });

  test("maps 503 to EXTERNAL (retryable)", () => {
    const err = mapMcpError(new Error("Service unavailable"), {
      serverName: "s1",
      httpStatus: 503,
    });
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(true);
  });

  test("maps 504 to TIMEOUT (retryable)", () => {
    const err = mapMcpError(new Error("Gateway timeout"), {
      serverName: "s1",
      httpStatus: 504,
    });
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
  });

  test("maps 400 to VALIDATION", () => {
    const err = mapMcpError(new Error("Bad request"), {
      serverName: "s1",
      httpStatus: 400,
    });
    expect(err.code).toBe("VALIDATION");
    expect(err.retryable).toBe(false);
  });

  test("HTTP status takes priority over message patterns", () => {
    // Message says "timeout" but HTTP status says 401 (AUTH_REQUIRED)
    const err = mapMcpError(new Error("timeout connecting"), {
      serverName: "s1",
      httpStatus: 401,
    });
    expect(err.code).toBe("AUTH_REQUIRED");
  });

  test("unknown HTTP status falls through to message patterns", () => {
    const err = mapMcpError(new Error("rate limit exceeded"), {
      serverName: "s1",
      httpStatus: 418, // I'm a teapot
    });
    expect(err.code).toBe("RATE_LIMIT");
  });
});

// ---------------------------------------------------------------------------
// mapMcpError — JSON-RPC error codes
// ---------------------------------------------------------------------------

describe("mapMcpError with JSON-RPC codes", () => {
  test("maps -32700 (parse error) to VALIDATION", () => {
    const err = mapMcpError(new Error("Parse error"), {
      serverName: "s1",
      jsonRpcCode: -32700,
    });
    expect(err.code).toBe("VALIDATION");
    expect(err.retryable).toBe(false);
  });

  test("maps -32601 (method not found) to NOT_FOUND", () => {
    const err = mapMcpError(new Error("Method not found"), {
      serverName: "s1",
      jsonRpcCode: -32601,
    });
    expect(err.code).toBe("NOT_FOUND");
  });

  test("maps -32603 (internal error) to EXTERNAL (retryable)", () => {
    const err = mapMcpError(new Error("Internal error"), {
      serverName: "s1",
      jsonRpcCode: -32603,
    });
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(true);
  });

  test("HTTP status takes priority over JSON-RPC code", () => {
    const err = mapMcpError(new Error("error"), {
      serverName: "s1",
      httpStatus: 429,
      jsonRpcCode: -32603,
    });
    expect(err.code).toBe("RATE_LIMIT"); // HTTP 429 wins
  });
});

// ---------------------------------------------------------------------------
// mapMcpError — message pattern fallback
// ---------------------------------------------------------------------------

describe("mapMcpError with message patterns", () => {
  test("matches rate limit patterns", () => {
    expect(mapMcpError(new Error("rate limit exceeded"), { serverName: "s1" }).code).toBe(
      "RATE_LIMIT",
    );
    expect(mapMcpError(new Error("too many requests"), { serverName: "s1" }).code).toBe(
      "RATE_LIMIT",
    );
  });

  test("matches timeout patterns", () => {
    expect(mapMcpError(new Error("request timeout"), { serverName: "s1" }).code).toBe("TIMEOUT");
    expect(mapMcpError(new Error("ETIMEDOUT"), { serverName: "s1" }).code).toBe("TIMEOUT");
  });

  test("matches connection error patterns", () => {
    expect(mapMcpError(new Error("connection refused"), { serverName: "s1" }).code).toBe(
      "EXTERNAL",
    );
    expect(mapMcpError(new Error("ECONNRESET"), { serverName: "s1" }).code).toBe("EXTERNAL");
    expect(mapMcpError(new Error("socket hang up"), { serverName: "s1" }).code).toBe("EXTERNAL");
    expect(mapMcpError(new Error("EPIPE"), { serverName: "s1" }).code).toBe("EXTERNAL");
  });

  test("matches permission patterns", () => {
    expect(mapMcpError(new Error("unauthorized"), { serverName: "s1" }).code).toBe("PERMISSION");
    expect(mapMcpError(new Error("forbidden"), { serverName: "s1" }).code).toBe("PERMISSION");
  });

  test("matches not-found patterns", () => {
    expect(mapMcpError(new Error("not found"), { serverName: "s1" }).code).toBe("NOT_FOUND");
    expect(mapMcpError(new Error("unknown tool"), { serverName: "s1" }).code).toBe("NOT_FOUND");
  });

  test("falls back to EXTERNAL for unknown messages", () => {
    const err = mapMcpError(new Error("something weird happened"), {
      serverName: "s1",
    });
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(false); // EXTERNAL default
  });

  test("preserves cause when error is an Error instance", () => {
    const cause = new Error("original");
    const err = mapMcpError(cause, { serverName: "s1" });
    expect(err.cause).toBe(cause);
  });

  test("no cause when error is not an Error instance", () => {
    const err = mapMcpError("string error", { serverName: "s1" });
    expect(err.cause).toBeUndefined();
  });

  test("includes server name in context", () => {
    const err = mapMcpError(new Error("oops"), { serverName: "my-server" });
    expect(err.context).toEqual({ serverName: "my-server" });
  });

  test("includes server name in message", () => {
    const err = mapMcpError(new Error("oops"), { serverName: "my-server" });
    expect(err.message).toContain("my-server");
  });
});

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

describe("error factory helpers", () => {
  test("connectionTimeoutError", () => {
    const err = connectionTimeoutError("srv", 5000);
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("5000ms");
    expect(err.message).toContain("srv");
  });

  test("notConnectedError", () => {
    const err = notConnectedError("srv");
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("not connected");
  });

  test("reconnectExhaustedError", () => {
    const err = reconnectExhaustedError("srv", 5);
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("5 attempts");
  });

  test("sessionExpiredError", () => {
    const err = sessionExpiredError("srv");
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("session expired");
  });
});
