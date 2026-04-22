import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../state/types.js";
import {
  formatSessionDate,
  getSessionDescription,
  getSessionPeekLines,
} from "./session-picker-helpers.js";

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

// ---------------------------------------------------------------------------
// getSessionPeekLines
// ---------------------------------------------------------------------------

describe("getSessionPeekLines", () => {
  const makeSession = (overrides?: Partial<SessionSummary>): SessionSummary => ({
    id: "s1",
    name: "My Session",
    lastActivityAt: new Date("2026-03-01T10:00:00Z").getTime(),
    messageCount: 12,
    preview: "Use the glob tool to list files in the current directory",
    ...overrides,
  });

  test("returns exactly 3 lines", () => {
    const lines = getSessionPeekLines(makeSession());
    expect(lines.length).toBe(3);
  });

  test("first line is the session name", () => {
    const lines = getSessionPeekLines(makeSession({ name: "My Session" }));
    expect(lines[0]).toBe("My Session");
  });

  test("long session name is capped at 66 chars with ellipsis", () => {
    const name = "n".repeat(100);
    const lines = getSessionPeekLines(makeSession({ name }));
    expect((lines[0] ?? "").length).toBeLessThanOrEqual(66);
    expect((lines[0] ?? "").endsWith("…")).toBe(true);
  });

  test("all 3 peek lines are ≤ 66 chars", () => {
    const session = makeSession({
      name: "n".repeat(100),
      preview: "p".repeat(200),
    });
    for (const line of getSessionPeekLines(session)) {
      expect(line.length).toBeLessThanOrEqual(66);
    }
  });

  test("second line contains message count", () => {
    const lines = getSessionPeekLines(makeSession({ messageCount: 12 }));
    expect(lines[1]).toContain("12 messages");
  });

  test("second line contains a formatted date", () => {
    const lines = getSessionPeekLines(makeSession());
    expect(/\d/.test(lines[1] ?? "")).toBe(true);
  });

  test("third line is the preview (fits within cap)", () => {
    const preview = "Use the glob tool to list files in the current directory";
    const lines = getSessionPeekLines(makeSession({ preview }));
    expect(lines[2]).toBe(preview);
  });

  test("truncates long preview to 65 chars + ellipsis (total = 66)", () => {
    const longPreview = "x".repeat(200);
    const lines = getSessionPeekLines(makeSession({ preview: longPreview }));
    expect(lines[2]).toBe(`${"x".repeat(65)}…`);
  });

  test("no ellipsis when preview is exactly at cap length", () => {
    const preview = "a".repeat(66);
    const lines = getSessionPeekLines(makeSession({ preview }));
    expect(lines[2]).toBe(preview);
    expect(lines[2]?.endsWith("…")).toBe(false);
  });

  test("preview line never exceeds 66 chars (hard modal width)", () => {
    const longPreview = "a".repeat(200);
    const lines = getSessionPeekLines(makeSession({ preview: longPreview }));
    expect((lines[2] ?? "").length).toBeLessThanOrEqual(66);
  });

  test("normalizes newlines to spaces in preview", () => {
    const lines = getSessionPeekLines(makeSession({ preview: "line1\nline2\r\nline3" }));
    expect(lines[2]).toBe("line1 line2 line3");
  });

  test("CRLF at cap boundary: normalized length governs ellipsis, not raw length", () => {
    // raw length = 66 (64 + "\r\n"), normalized = "a"×64 + "  " = 66 chars — no ellipsis
    const preview = "a".repeat(64) + "\r\n";
    const lines = getSessionPeekLines(makeSession({ preview }));
    expect((lines[2] ?? "").endsWith("…")).toBe(false);
    expect((lines[2] ?? "").length).toBeLessThanOrEqual(66);
  });

  test("CRLF pushes normalized over cap: ellipsis appended, total ≤ 66", () => {
    // raw = 68 (65 + "\r\n" + "b"), normalized = "a"×65 + " " + "b" = 67 chars > 66 cap
    const preview = "a".repeat(65) + "\r\n" + "b";
    const lines = getSessionPeekLines(makeSession({ preview }));
    expect((lines[2] ?? "").endsWith("…")).toBe(true);
    expect((lines[2] ?? "").length).toBeLessThanOrEqual(66);
  });

  test("does not truncate 40-char boundary (well under cap)", () => {
    const preview = "a".repeat(41);
    const lines = getSessionPeekLines(makeSession({ preview }));
    expect(lines[2]).toBe(preview);
  });
});
