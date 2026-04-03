/**
 * Table-driven tests for mapNexusError — one test per JSON-RPC error code mapping.
 */

import { describe, expect, test } from "bun:test";
import type { KoiErrorCode } from "@koi/core";
import { METHOD_NOT_FOUND_CODE, mapNexusError } from "./errors.js";

// ---------------------------------------------------------------------------
// Table-driven: JSON-RPC code → KoiError mapping
// ---------------------------------------------------------------------------

const RPC_CODE_TABLE: ReadonlyArray<{
  readonly rpcCode: number;
  readonly expectedCode: KoiErrorCode;
  readonly retryable: boolean;
  readonly label: string;
}> = [
  { rpcCode: -32000, expectedCode: "NOT_FOUND", retryable: false, label: "FILE_NOT_FOUND" },
  { rpcCode: -32001, expectedCode: "CONFLICT", retryable: false, label: "FILE_EXISTS" },
  { rpcCode: -32002, expectedCode: "VALIDATION", retryable: false, label: "INVALID_PATH" },
  { rpcCode: -32003, expectedCode: "PERMISSION", retryable: false, label: "ACCESS_DENIED" },
  { rpcCode: -32004, expectedCode: "PERMISSION", retryable: false, label: "PERMISSION_ERROR" },
  { rpcCode: -32005, expectedCode: "VALIDATION", retryable: false, label: "VALIDATION_ERROR" },
  { rpcCode: -32006, expectedCode: "CONFLICT", retryable: true, label: "OCC CONFLICT" },
  {
    rpcCode: METHOD_NOT_FOUND_CODE,
    expectedCode: "EXTERNAL",
    retryable: false,
    label: "METHOD_NOT_FOUND",
  },
];

describe("mapNexusError", () => {
  describe("JSON-RPC error codes", () => {
    for (const { rpcCode, expectedCode, retryable, label } of RPC_CODE_TABLE) {
      test(`${label} (${String(rpcCode)}) → ${expectedCode}, retryable=${String(retryable)}`, () => {
        const rpcError = { code: rpcCode, message: `test: ${label}` };
        const result = mapNexusError(rpcError, "test-op");
        expect(result.code).toBe(expectedCode);
        expect(result.retryable).toBe(retryable);
        expect(result.message).toContain(label);
      });
    }
  });

  test("unknown RPC code maps to EXTERNAL", () => {
    const rpcError = { code: -99999, message: "something weird" };
    const result = mapNexusError(rpcError, "test-op");
    expect(result.code).toBe("EXTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("HTTP 429 maps to RATE_LIMIT", () => {
    const httpError = { status: 429, statusText: "Too Many Requests" };
    const result = mapNexusError(httpError, "test-op");
    expect(result.code).toBe("RATE_LIMIT");
    expect(result.retryable).toBe(true);
  });

  test("HTTP 500 maps to INTERNAL with retryable", () => {
    const httpError = { status: 500, statusText: "Internal Server Error" };
    const result = mapNexusError(httpError, "test-op");
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(true);
  });

  test("HTTP 502/503 map to INTERNAL with retryable", () => {
    for (const status of [502, 503]) {
      const httpError = { status, statusText: "Bad Gateway" };
      const result = mapNexusError(httpError, "test-op");
      expect(result.code).toBe("INTERNAL");
      expect(result.retryable).toBe(true);
    }
  });

  test("network error (TypeError) maps to TIMEOUT", () => {
    const error = new TypeError("fetch failed");
    const result = mapNexusError(error, "test-op");
    expect(result.code).toBe("TIMEOUT");
    expect(result.retryable).toBe(true);
    expect(result.cause).toBe(error);
  });

  test("AbortError maps to TIMEOUT", () => {
    const error = new DOMException("signal is aborted", "AbortError");
    const result = mapNexusError(error, "test-op");
    expect(result.code).toBe("TIMEOUT");
    expect(result.retryable).toBe(true);
  });

  test("generic Error preserves cause chain", () => {
    const original = new Error("connection refused");
    const result = mapNexusError(original, "test-op");
    expect(result.cause).toBe(original);
    expect(result.message).toContain("connection refused");
  });

  test("context field includes operation name", () => {
    const rpcError = { code: -32000, message: "not found" };
    const result = mapNexusError(rpcError, "read");
    expect(result.context).toBeDefined();
    expect(result.context?.operation).toBe("read");
  });
});
