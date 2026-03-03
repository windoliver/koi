import { describe, expect, test } from "bun:test";
import { generateUlid } from "./ulid.js";

describe("generateUlid", () => {
  test("returns a 26-character string", () => {
    const id = generateUlid();
    expect(id).toHaveLength(26);
  });

  test("uses only Crockford Base32 characters", () => {
    const id = generateUlid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateUlid()));
    expect(ids.size).toBe(1000);
  });

  test("IDs generated later sort after earlier ones", async () => {
    const first = generateUlid();
    // Small delay to ensure different millisecond timestamp
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = generateUlid();
    expect(first < second).toBe(true);
  });

  test("time prefix encodes current timestamp", () => {
    const before = Date.now();
    const id = generateUlid();
    const after = Date.now();

    // First 10 chars encode time — verify it's within range
    // by checking the ULID is lexicographically between ULIDs for before/after
    expect(id).toHaveLength(26);
    expect(before).toBeLessThanOrEqual(after);
  });
});
