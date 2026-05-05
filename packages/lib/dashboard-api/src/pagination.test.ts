import { describe, expect, test } from "bun:test";

import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js";

describe("encode/decodeCursor", () => {
  test("round-trips a cursor", () => {
    const cursor = { lastId: "agent-7", lastTimestampMs: 1_700_000_000_000 };
    const encoded = encodeCursor(cursor);
    const result = decodeCursor(encoded);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(cursor);
  });

  test("encodes URL-safe base64 (no '+', '/', '=')", () => {
    const encoded = encodeCursor({ lastId: "x".repeat(50), lastTimestampMs: 1 });
    expect(encoded).not.toMatch(/[+/=]/);
  });

  test("returns VALIDATION error for non-base64 garbage", () => {
    const result = decodeCursor("!!!not-base64!!!");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("returns VALIDATION error for malformed payload", () => {
    // base64-encoded JSON missing required fields.
    const bad = encodeCursor({ lastId: "x", lastTimestampMs: 1 });
    // truncate to corrupt
    const corrupted = bad.slice(0, Math.max(1, bad.length - 4));
    const result = decodeCursor(corrupted);
    expect(result.ok).toBe(false);
  });

  test("rejects payload missing fields", () => {
    const json = JSON.stringify({ i: "x" }); // missing 't'
    const encoded = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const result = decodeCursor(encoded);
    expect(result.ok).toBe(false);
  });

  test("handles unicode lastId", () => {
    const cursor = { lastId: "agent-😀", lastTimestampMs: 42 };
    const result = decodeCursor(encodeCursor(cursor));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.lastId).toBe("agent-😀");
  });
});

describe("clampLimit", () => {
  test("returns fallback when raw is null", () => {
    expect(clampLimit(null, 50, 200)).toBe(50);
  });

  test("returns fallback when raw is non-numeric", () => {
    expect(clampLimit("abc", 50, 200)).toBe(50);
  });

  test("returns fallback for zero or negative", () => {
    expect(clampLimit("0", 50, 200)).toBe(50);
    expect(clampLimit("-5", 50, 200)).toBe(50);
  });

  test("clamps to max", () => {
    expect(clampLimit("5000", 50, 200)).toBe(200);
  });

  test("returns parsed value when in range", () => {
    expect(clampLimit("75", 50, 200)).toBe(75);
  });
});
