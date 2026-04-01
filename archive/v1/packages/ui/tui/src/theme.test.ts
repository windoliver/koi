import { describe, expect, test } from "bun:test";

import { abbreviateModel, computeLayoutTier, separator, truncate } from "./theme.js";

describe("computeLayoutTier", () => {
  test("returns 'full' for cols >= 120", () => {
    expect(computeLayoutTier(120)).toBe("full");
    expect(computeLayoutTier(200)).toBe("full");
  });

  test("returns 'compact' for cols 100-119", () => {
    expect(computeLayoutTier(100)).toBe("compact");
    expect(computeLayoutTier(119)).toBe("compact");
  });

  test("returns 'narrow' for cols 80-99", () => {
    expect(computeLayoutTier(80)).toBe("narrow");
    expect(computeLayoutTier(99)).toBe("narrow");
  });

  test("returns 'tooNarrow' for cols < 80", () => {
    expect(computeLayoutTier(79)).toBe("tooNarrow");
    expect(computeLayoutTier(0)).toBe("tooNarrow");
    expect(computeLayoutTier(1)).toBe("tooNarrow");
  });

  test("boundary values at exactly 80, 100, 120", () => {
    expect(computeLayoutTier(80)).toBe("narrow");
    expect(computeLayoutTier(100)).toBe("compact");
    expect(computeLayoutTier(120)).toBe("full");
  });

  test("off-by-one at 79, 99, 119", () => {
    expect(computeLayoutTier(79)).toBe("tooNarrow");
    expect(computeLayoutTier(99)).toBe("narrow");
    expect(computeLayoutTier(119)).toBe("compact");
  });
});

describe("truncate", () => {
  test("pads short string to exact width", () => {
    expect(truncate("abc", 6)).toBe("abc   ");
  });

  test("truncates long string to exact width", () => {
    expect(truncate("abcdefgh", 4)).toBe("abcd");
  });

  test("returns exact string when length equals width", () => {
    expect(truncate("abcd", 4)).toBe("abcd");
  });

  test("handles empty string", () => {
    expect(truncate("", 5)).toBe("     ");
  });

  test("handles width 0", () => {
    expect(truncate("abc", 0)).toBe("");
  });
});

describe("abbreviateModel", () => {
  test("abbreviates haiku to h", () => {
    expect(abbreviateModel("haiku-4.5")).toBe("h");
  });

  test("abbreviates sonnet to s", () => {
    expect(abbreviateModel("sonnet-4.5")).toBe("s");
  });

  test("abbreviates opus to o", () => {
    expect(abbreviateModel("opus")).toBe("o");
  });

  test("returns ? for empty string", () => {
    expect(abbreviateModel("")).toBe("?");
  });
});

describe("separator", () => {
  test("returns 80 dashes at cols 120", () => {
    expect(separator(120).length).toBe(80);
  });

  test("returns cols-2 dashes at cols 50", () => {
    expect(separator(50).length).toBe(48);
  });

  test("returns 78 dashes at cols 80", () => {
    expect(separator(80).length).toBe(78);
  });

  test("contains only dash characters", () => {
    const result = separator(50);
    expect(result).toMatch(/^─+$/);
  });

  test("returns empty string at cols 0", () => {
    expect(separator(0)).toBe("");
  });

  test("never exceeds 80 characters", () => {
    expect(separator(200).length).toBe(80);
  });
});
