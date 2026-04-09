import { describe, expect, test } from "bun:test";
import {
  capabilityNotSupportedError,
  connectionTimeoutError,
  isConnectionError,
  jsonRpcError,
  mapLspError,
  notConnectedError,
  reconnectExhaustedError,
  serverStartError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// mapLspError
// ---------------------------------------------------------------------------

describe("mapLspError", () => {
  test("maps timeout errors", () => {
    const err = mapLspError(new Error("Request timeout"), "ts-server");
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("ts-server");
  });

  test("maps connection refused errors", () => {
    const err = mapLspError(new Error("ECONNREFUSED"), "pyright");
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(true);
  });

  test("maps ENOENT errors to NOT_FOUND", () => {
    const err = mapLspError(new Error("ENOENT: no such file"), "gopls");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.retryable).toBe(false);
  });

  test("maps invalid errors to VALIDATION", () => {
    const err = mapLspError(new Error("invalid params"), "ts-server");
    expect(err.code).toBe("VALIDATION");
    expect(err.retryable).toBe(false);
  });

  test("falls back to EXTERNAL for unknown errors", () => {
    const err = mapLspError(new Error("something weird"), "ts-server");
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(false);
  });

  test("handles string errors", () => {
    const err = mapLspError("timeout exceeded", "ts-server");
    expect(err.code).toBe("TIMEOUT");
  });

  test("preserves Error cause", () => {
    const original = new Error("connection refused");
    const err = mapLspError(original, "ts-server");
    expect(err.cause).toBe(original);
  });

  test("includes serverName in context", () => {
    const err = mapLspError(new Error("oops"), "pyright");
    expect(err.context).toEqual({ serverName: "pyright" });
  });
});

// ---------------------------------------------------------------------------
// isConnectionError
// ---------------------------------------------------------------------------

describe("isConnectionError", () => {
  test("returns true for EPIPE errors", () => {
    expect(isConnectionError(new Error("EPIPE: broken pipe"))).toBe(true);
  });

  test("returns true for connection closed", () => {
    expect(isConnectionError(new Error("connection closed"))).toBe(true);
  });

  test("returns true for connection reset", () => {
    expect(isConnectionError(new Error("connection reset"))).toBe(true);
  });

  test("returns true for ECONNRESET", () => {
    expect(isConnectionError(new Error("ECONNRESET"))).toBe(true);
  });

  test("returns true for disposed", () => {
    expect(isConnectionError(new Error("Connection disposed"))).toBe(true);
  });

  test("returns false for method not found", () => {
    expect(isConnectionError(new Error("Method not found"))).toBe(false);
  });

  test("returns false for timeout", () => {
    expect(isConnectionError(new Error("Request timeout after 30000ms"))).toBe(false);
  });

  test("returns false for non-Error", () => {
    expect(isConnectionError("plain string error")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

describe("connectionTimeoutError", () => {
  test("creates timeout error with server name and ms", () => {
    const err = connectionTimeoutError("ts-server", 30_000);
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("ts-server");
    expect(err.message).toContain("30000");
  });
});

describe("serverStartError", () => {
  test("creates start error from cause", () => {
    const cause = new Error("ENOENT: no such file");
    const err = serverStartError("gopls", cause);
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("failed to start");
    expect(err.cause).toBe(cause);
  });
});

describe("notConnectedError", () => {
  test("creates not-connected error", () => {
    const err = notConnectedError("ts-server");
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("not connected");
  });
});

describe("reconnectExhaustedError", () => {
  test("creates reconnect exhausted error", () => {
    const err = reconnectExhaustedError("ts-server", 2);
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("2 attempts");
  });
});

describe("jsonRpcError", () => {
  test("creates JSON-RPC error", () => {
    const err = jsonRpcError("ts-server", -32601, "Method not found");
    expect(err.code).toBe("EXTERNAL");
    expect(err.message).toContain("-32601");
    expect(err.message).toContain("Method not found");
  });
});

describe("capabilityNotSupportedError", () => {
  test("creates capability error", () => {
    const err = capabilityNotSupportedError("ts-server", "hoverProvider");
    expect(err.code).toBe("VALIDATION");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("hoverProvider");
  });
});
