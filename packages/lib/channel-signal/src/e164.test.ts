import { describe, expect, test } from "bun:test";
import { isE164, normalizeE164 } from "./e164.js";

describe("@koi/channel-signal e164", () => {
  test("isE164 accepts valid E.164", () => {
    expect(isE164("+15551234567")).toBe(true);
    expect(isE164("+441234567890")).toBe(true);
  });

  test("isE164 rejects invalid forms", () => {
    expect(isE164("15551234567")).toBe(false);
    expect(isE164("+0123456789")).toBe(false);
    expect(isE164("not-a-number")).toBe(false);
    expect(isE164("")).toBe(false);
  });

  test("normalizeE164 strips formatting characters", () => {
    expect(normalizeE164("+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeE164("+1.555.123.4567")).toBe("+15551234567");
  });

  test("normalizeE164 prepends + when input is bare digits", () => {
    expect(normalizeE164("15551234567")).toBe("+15551234567");
  });

  test("normalizeE164 returns null for unsalvageable input", () => {
    expect(normalizeE164("hello")).toBeNull();
    expect(normalizeE164("0")).toBeNull();
    expect(normalizeE164("+0")).toBeNull();
  });
});
