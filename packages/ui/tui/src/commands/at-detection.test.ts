import { describe, expect, test } from "bun:test";
import { detectAtPrefix } from "./at-detection.js";

// ---------------------------------------------------------------------------
// detectAtPrefix
// ---------------------------------------------------------------------------

describe("detectAtPrefix", () => {
  test("returns partial path for '@' at position 0", () => {
    expect(detectAtPrefix("@src/m")).toBe("src/m");
  });

  test("returns empty string for bare '@'", () => {
    expect(detectAtPrefix("@")).toBe("");
  });

  test("returns partial when '@' is preceded by space", () => {
    expect(detectAtPrefix("hello @src/m")).toBe("src/m");
  });

  test("returns partial when '@' is preceded by newline", () => {
    expect(detectAtPrefix("line1\n@utils")).toBe("utils");
  });

  test("returns null when '@' is mid-word (no preceding whitespace)", () => {
    expect(detectAtPrefix("user@example.com")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(detectAtPrefix("")).toBeNull();
  });

  test("returns null when partial contains space", () => {
    expect(detectAtPrefix("@has space")).toBeNull();
  });

  test("returns null when partial contains newline", () => {
    expect(detectAtPrefix("@has\nnewline")).toBeNull();
  });

  test("returns null when no '@' present", () => {
    expect(detectAtPrefix("just some text")).toBeNull();
  });

  test("uses last '@' when multiple present", () => {
    expect(detectAtPrefix("@first @second")).toBe("second");
  });

  test("handles path-like input with slashes", () => {
    expect(detectAtPrefix("@src/components/App.tsx")).toBe("src/components/App.tsx");
  });

  test("returns null for '@' followed by space immediately", () => {
    expect(detectAtPrefix("@ something")).toBeNull();
  });

  test("handles tab character before '@' as non-whitespace", () => {
    // Tab is not space or newline — should not trigger
    expect(detectAtPrefix("text\t@foo")).toBeNull();
  });
});
