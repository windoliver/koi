import { describe, expect, test } from "bun:test";
import { isE164, normalizeE164 } from "./e164.js";

describe("isE164", () => {
  test("accepts valid E.164 numbers", () => {
    expect(isE164("+12025551234")).toBe(true);
    expect(isE164("+442071234567")).toBe(true);
    expect(isE164("+1")).toBe(false); // Too short (need at least 2 digits after +)
    expect(isE164("+19")).toBe(true);
  });

  test("rejects numbers without + prefix", () => {
    expect(isE164("12025551234")).toBe(false);
  });

  test("rejects numbers with formatting characters", () => {
    expect(isE164("+1 202 555 1234")).toBe(false);
    expect(isE164("+1-202-555-1234")).toBe(false);
  });

  test("rejects empty or invalid strings", () => {
    expect(isE164("")).toBe(false);
    expect(isE164("+")).toBe(false);
    expect(isE164("+0123")).toBe(false); // Leading zero after +
    expect(isE164("abc")).toBe(false);
  });
});

describe("normalizeE164", () => {
  test("returns valid E.164 numbers as-is", () => {
    expect(normalizeE164("+12025551234")).toBe("+12025551234");
  });

  test("strips whitespace and dashes", () => {
    expect(normalizeE164("+1 202 555 1234")).toBe("+12025551234");
    expect(normalizeE164("+1-202-555-1234")).toBe("+12025551234");
  });

  test("strips dots and parentheses", () => {
    expect(normalizeE164("+1 (202) 555.1234")).toBe("+12025551234");
  });

  test("prepends + to bare digit strings", () => {
    expect(normalizeE164("12025551234")).toBe("+12025551234");
  });

  test("returns null for invalid numbers", () => {
    expect(normalizeE164("abc")).toBeNull();
    expect(normalizeE164("")).toBeNull();
    expect(normalizeE164("+")).toBeNull();
  });

  test("returns null for numbers starting with 0", () => {
    expect(normalizeE164("0123456789")).toBeNull();
  });
});
