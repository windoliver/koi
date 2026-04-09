import { describe, expect, it } from "bun:test";
import {
  checkReservedHeaders,
  RESERVED_HEADER_NAMES,
  validateHeaders,
  validateHeaderValue,
} from "./header-sanitize.js";

// ---------------------------------------------------------------------------
// validateHeaderValue
// ---------------------------------------------------------------------------

describe("validateHeaderValue", () => {
  it("accepts clean value", () => {
    expect(validateHeaderValue("Bearer sk-abc123")).toBe(true);
  });

  it("accepts empty string", () => {
    expect(validateHeaderValue("")).toBe(true);
  });

  it("rejects \\r", () => {
    expect(validateHeaderValue("value\rwith-cr")).toBe(false);
  });

  it("rejects \\n", () => {
    expect(validateHeaderValue("value\nwith-lf")).toBe(false);
  });

  it("rejects \\r\\n", () => {
    expect(validateHeaderValue("Bearer token\r\nX-Evil: injected")).toBe(false);
  });

  it("rejects \\0 (null byte)", () => {
    expect(validateHeaderValue("value\0with-null")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateHeaders
// ---------------------------------------------------------------------------

describe("validateHeaders", () => {
  it("returns undefined for clean headers", () => {
    expect(validateHeaders({ Authorization: "Bearer token", "X-Custom": "value" })).toBeUndefined();
  });

  it("returns error for value with control chars", () => {
    const result = validateHeaders({ Authorization: "Bearer\r\nEvil: inject" });
    expect(result).toContain("Authorization");
    expect(result).toContain("control characters");
  });

  it("returns error for key with control chars", () => {
    const result = validateHeaders({ "X-Bad\nHeader": "value" });
    expect(result).toContain("control characters");
  });

  it("returns undefined for empty record", () => {
    expect(validateHeaders({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkReservedHeaders
// ---------------------------------------------------------------------------

describe("checkReservedHeaders", () => {
  it("returns undefined for non-reserved headers", () => {
    expect(
      checkReservedHeaders({ Authorization: "Bearer token", "X-Custom": "v" }),
    ).toBeUndefined();
  });

  it("rejects Host header", () => {
    const result = checkReservedHeaders({ Host: "evil.com" });
    expect(result).toContain("Host");
    expect(result).toContain("reserved");
  });

  it("rejects host (case-insensitive)", () => {
    const result = checkReservedHeaders({ host: "evil.com" });
    expect(result).toContain("host");
    expect(result).toContain("reserved");
  });

  it("rejects Content-Length", () => {
    const result = checkReservedHeaders({ "Content-Length": "999" });
    expect(result).toContain("Content-Length");
  });

  it("rejects Transfer-Encoding", () => {
    const result = checkReservedHeaders({ "Transfer-Encoding": "chunked" });
    expect(result).toContain("Transfer-Encoding");
  });

  it("rejects Connection", () => {
    const result = checkReservedHeaders({ Connection: "keep-alive" });
    expect(result).toContain("Connection");
  });

  it("returns undefined for empty record", () => {
    expect(checkReservedHeaders({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RESERVED_HEADER_NAMES
// ---------------------------------------------------------------------------

describe("RESERVED_HEADER_NAMES", () => {
  it("contains expected headers", () => {
    expect(RESERVED_HEADER_NAMES.has("host")).toBe(true);
    expect(RESERVED_HEADER_NAMES.has("content-length")).toBe(true);
    expect(RESERVED_HEADER_NAMES.has("transfer-encoding")).toBe(true);
    expect(RESERVED_HEADER_NAMES.has("connection")).toBe(true);
  });

  it("does not contain non-reserved headers", () => {
    expect(RESERVED_HEADER_NAMES.has("authorization")).toBe(false);
    expect(RESERVED_HEADER_NAMES.has("x-custom")).toBe(false);
  });
});
