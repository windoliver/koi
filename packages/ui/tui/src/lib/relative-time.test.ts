import { describe, expect, test } from "bun:test";
import { relativeTime } from "./relative-time.js";

describe("relativeTime", () => {
  const NOW = 1_700_000_000_000; // fixed reference point

  test("returns 'just now' for timestamps less than 1 minute ago", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 59_999, NOW)).toBe("just now");
    expect(relativeTime(NOW, NOW)).toBe("just now");
  });

  test("returns 'just now' for future timestamps (clock skew)", () => {
    expect(relativeTime(NOW + 5_000, NOW)).toBe("just now");
  });

  test("returns minutes for 1m–59m range", () => {
    expect(relativeTime(NOW - 60_000, NOW)).toBe("1m ago");
    expect(relativeTime(NOW - 120_000, NOW)).toBe("2m ago");
    expect(relativeTime(NOW - 3_540_000, NOW)).toBe("59m ago");
  });

  test("returns hours for 1h–23h range", () => {
    expect(relativeTime(NOW - 3_600_000, NOW)).toBe("1h ago");
    expect(relativeTime(NOW - 7_200_000, NOW)).toBe("2h ago");
    expect(relativeTime(NOW - 82_800_000, NOW)).toBe("23h ago");
  });

  test("returns days for 24h+ range", () => {
    expect(relativeTime(NOW - 86_400_000, NOW)).toBe("1d ago");
    expect(relativeTime(NOW - 172_800_000, NOW)).toBe("2d ago");
    expect(relativeTime(NOW - 604_800_000, NOW)).toBe("7d ago");
  });

  test("floors fractional values (does not round up)", () => {
    // 1 minute and 59 seconds = 119_000ms → should be "1m ago" not "2m ago"
    expect(relativeTime(NOW - 119_000, NOW)).toBe("1m ago");
    // 1 hour and 59 minutes → should be "1h ago" not "2h ago"
    expect(relativeTime(NOW - 7_140_000, NOW)).toBe("1h ago");
  });
});
