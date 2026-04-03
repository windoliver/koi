import { describe, expect, test } from "bun:test";
import { CLOSE_CODE_MAP, CLOSE_CODES, closeCodeLabel, isRetryableClose } from "../close-codes.js";

describe("CLOSE_CODE_MAP", () => {
  test("has entries for all 14 gateway close codes plus 2 standard codes", () => {
    const expectedCodes = [
      1000, 1001, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 4010, 4011, 4012, 4013,
      4014,
    ];
    expect(CLOSE_CODE_MAP.size).toBe(expectedCodes.length);
    for (const code of expectedCodes) {
      expect(CLOSE_CODE_MAP.has(code)).toBe(true);
    }
  });
});

describe("isRetryableClose", () => {
  test("returns correct classification for each code", () => {
    // Non-retryable codes
    expect(isRetryableClose(1000)).toBe(false); // Normal closure
    expect(isRetryableClose(4001)).toBe(false); // Auth timeout
    expect(isRetryableClose(4002)).toBe(false); // Invalid handshake
    expect(isRetryableClose(4003)).toBe(false); // Auth failed
    expect(isRetryableClose(4007)).toBe(false); // Session not found
    expect(isRetryableClose(4010)).toBe(false); // Protocol version mismatch
    expect(isRetryableClose(4012)).toBe(false); // Administratively closed
    expect(isRetryableClose(4014)).toBe(false); // Node replaced by reconnect

    // Retryable codes
    expect(isRetryableClose(1001)).toBe(true); // Server shutting down
    expect(isRetryableClose(4004)).toBe(true); // Session expired
    expect(isRetryableClose(4005)).toBe(true); // Max connections exceeded
    expect(isRetryableClose(4006)).toBe(true); // Buffer limit exceeded
    expect(isRetryableClose(4008)).toBe(true); // Session store failure
    expect(isRetryableClose(4009)).toBe(true); // Backpressure timeout
    expect(isRetryableClose(4011)).toBe(true); // Session expired during processing
    expect(isRetryableClose(4013)).toBe(true); // Node heartbeat expired

    // Unknown codes default to retryable
    expect(isRetryableClose(9999)).toBe(true);
  });
});

describe("CLOSE_CODES", () => {
  test("constant values match CLOSE_CODE_MAP keys", () => {
    const codeValues = Object.values(CLOSE_CODES)
      .map(Number)
      .sort((a, b) => a - b);
    const mapKeys = [...CLOSE_CODE_MAP.keys()].sort((a, b) => a - b);
    expect(codeValues).toEqual(mapKeys);
  });
});

describe("closeCodeLabel", () => {
  test("returns human-readable string for all codes", () => {
    for (const [code, entry] of CLOSE_CODE_MAP) {
      expect(closeCodeLabel(code)).toBe(entry.label);
    }
  });

  test("returns fallback for unknown code", () => {
    expect(closeCodeLabel(9999)).toBe("Unknown close code 9999");
  });
});
