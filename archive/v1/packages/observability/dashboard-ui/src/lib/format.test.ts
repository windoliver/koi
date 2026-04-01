import { describe, expect, test } from "bun:test";
import { formatBytes, formatDuration, formatRelativeTime } from "./format.js";

describe("formatDuration", () => {
  test("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  test("formats seconds", () => {
    expect(formatDuration(5000)).toBe("5s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  test("formats hours and minutes", () => {
    expect(formatDuration(3_723_000)).toBe("1h 2m");
  });

  test("formats days and hours", () => {
    expect(formatDuration(90_000_000)).toBe("1d 1h");
  });
});

describe("formatBytes", () => {
  test("formats megabytes", () => {
    expect(formatBytes(512)).toBe("512.0 MB");
  });

  test("formats gigabytes", () => {
    expect(formatBytes(2048)).toBe("2.0 GB");
  });
});

describe("formatRelativeTime", () => {
  test("formats recent timestamp", () => {
    const result = formatRelativeTime(Date.now() - 5000);
    expect(result).toBe("5s ago");
  });

  test("formats future timestamp as just now", () => {
    const result = formatRelativeTime(Date.now() + 5000);
    expect(result).toBe("just now");
  });
});
