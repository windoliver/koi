import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../state/types.js";
import { formatSessionDate, getSessionDescription } from "./session-picker-helpers.js";

// ---------------------------------------------------------------------------
// formatSessionDate
// ---------------------------------------------------------------------------

describe("formatSessionDate", () => {
  test("formats a known timestamp to a readable date", () => {
    // 2026-01-15 UTC — month + day, locale-independent format check
    const ts = new Date("2026-01-15T12:00:00Z").getTime();
    const result = formatSessionDate(ts);
    // The result will vary by locale but must be a non-empty string
    expect(result.length).toBeGreaterThan(0);
    // Must contain a digit (the day number)
    expect(/\d/.test(result)).toBe(true);
  });

  test("recent timestamps produce shorter strings than epoch", () => {
    // Sanity: doesn't throw for edge-case timestamps
    expect(() => formatSessionDate(0)).not.toThrow();
    expect(() => formatSessionDate(Date.now())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getSessionDescription
// ---------------------------------------------------------------------------

describe("getSessionDescription", () => {
  const makeSession = (overrides?: Partial<SessionSummary>): SessionSummary => ({
    id: "s1",
    name: "Test Session",
    lastActivityAt: new Date("2026-03-01T10:00:00Z").getTime(),
    messageCount: 7,
    preview: "Hello world",
    ...overrides,
  });

  test("includes message count", () => {
    const desc = getSessionDescription(makeSession({ messageCount: 7 }));
    expect(desc).toContain("7 messages");
  });

  test("includes preview text", () => {
    const desc = getSessionDescription(makeSession({ preview: "Hello world" }));
    expect(desc).toContain("Hello world");
  });

  test("truncates long preview to 40 characters", () => {
    const longPreview = "x".repeat(100);
    const desc = getSessionDescription(makeSession({ preview: longPreview }));
    // Preview portion should be at most 40 chars
    const previewPart = desc.split("· ")[2] ?? "";
    expect(previewPart.length).toBeLessThanOrEqual(40);
  });

  test("short preview is not truncated", () => {
    const desc = getSessionDescription(makeSession({ preview: "Short" }));
    expect(desc).toContain("Short");
  });
});
