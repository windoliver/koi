import { describe, expect, test } from "bun:test";
import {
  abbreviateModel,
  COLORS,
  CONNECTION_STATUS_CONFIG,
  computeLayoutTier,
  separator,
  truncate,
} from "./theme.js";

// ---------------------------------------------------------------------------
// COLORS
// ---------------------------------------------------------------------------

describe("COLORS", () => {
  test("all entries are non-empty hex strings", () => {
    for (const [key, value] of Object.entries(COLORS)) {
      expect(typeof value, `COLORS.${key}`).toBe("string");
      expect(value.length, `COLORS.${key} non-empty`).toBeGreaterThan(0);
      expect(value.startsWith("#"), `COLORS.${key} starts with #`).toBe(true);
    }
  });

  test("has expected semantic keys", () => {
    expect(COLORS.green).toBeDefined();
    expect(COLORS.red).toBeDefined();
    expect(COLORS.yellow).toBeDefined();
    expect(COLORS.bg).toBeDefined();
    expect(COLORS.border).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CONNECTION_STATUS_CONFIG
// ---------------------------------------------------------------------------

describe("CONNECTION_STATUS_CONFIG", () => {
  test("connected has indicator and color", () => {
    const cfg = CONNECTION_STATUS_CONFIG.connected;
    expect(typeof cfg.indicator).toBe("string");
    expect(cfg.indicator.length).toBeGreaterThan(0);
    expect(cfg.color).toBe(COLORS.green);
  });

  test("reconnecting has indicator and color", () => {
    const cfg = CONNECTION_STATUS_CONFIG.reconnecting;
    expect(cfg.color).toBe(COLORS.yellow);
    expect(cfg.indicator).toContain("reconnecting");
  });

  test("disconnected has indicator and color", () => {
    const cfg = CONNECTION_STATUS_CONFIG.disconnected;
    expect(cfg.color).toBe(COLORS.red);
    expect(cfg.indicator).toContain("disconnected");
  });

  test("covers all three ConnectionStatus values", () => {
    const keys = Object.keys(CONNECTION_STATUS_CONFIG);
    expect(keys).toContain("connected");
    expect(keys).toContain("reconnecting");
    expect(keys).toContain("disconnected");
    expect(keys.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// computeLayoutTier
// ---------------------------------------------------------------------------

describe("computeLayoutTier", () => {
  test("< 60 cols → compact", () => {
    expect(computeLayoutTier(0)).toBe("compact");
    expect(computeLayoutTier(40)).toBe("compact");
    expect(computeLayoutTier(59)).toBe("compact");
  });

  test("60-119 cols → normal", () => {
    expect(computeLayoutTier(60)).toBe("normal");
    expect(computeLayoutTier(80)).toBe("normal");
    expect(computeLayoutTier(119)).toBe("normal");
  });

  test(">= 120 cols → wide", () => {
    expect(computeLayoutTier(120)).toBe("wide");
    expect(computeLayoutTier(200)).toBe("wide");
    expect(computeLayoutTier(300)).toBe("wide");
  });

  test("boundary at 60 (inclusive → normal)", () => {
    expect(computeLayoutTier(59)).toBe("compact");
    expect(computeLayoutTier(60)).toBe("normal");
  });

  test("boundary at 120 (inclusive → wide)", () => {
    expect(computeLayoutTier(119)).toBe("normal");
    expect(computeLayoutTier(120)).toBe("wide");
  });
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {
  test("pads short strings with spaces", () => {
    expect(truncate("hi", 10)).toBe("hi        ");
    expect(truncate("", 5)).toBe("     ");
  });

  test("returns string of exact width", () => {
    expect(truncate("hello world", 5)).toBe("hello");
    expect(truncate("abc", 3)).toBe("abc");
  });

  test("exact-length string is returned as-is", () => {
    expect(truncate("exact", 5)).toBe("exact");
  });

  test("zero width returns empty string", () => {
    expect(truncate("hello", 0)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// separator
// ---------------------------------------------------------------------------

describe("separator", () => {
  test("returns a string of em-dashes", () => {
    const s = separator(40);
    expect(s).toBe("─".repeat(38)); // 40 - 2
  });

  test("caps at 80 dashes", () => {
    expect(separator(200).length).toBe(80);
    expect(separator(1000).length).toBe(80);
  });

  test("tiny terminals produce empty string", () => {
    expect(separator(0)).toBe("");
    expect(separator(1)).toBe("");
    expect(separator(2)).toBe("");
  });

  test("cols=3 produces one dash", () => {
    expect(separator(3)).toBe("─");
  });
});

// ---------------------------------------------------------------------------
// abbreviateModel
// ---------------------------------------------------------------------------

describe("abbreviateModel", () => {
  test("returns first character of model name", () => {
    expect(abbreviateModel("haiku-4.5")).toBe("h");
    expect(abbreviateModel("claude-sonnet")).toBe("c");
    expect(abbreviateModel("gpt-4")).toBe("g");
  });

  test("returns ? for empty string", () => {
    expect(abbreviateModel("")).toBe("?");
  });

  test("single char model returns that char", () => {
    expect(abbreviateModel("x")).toBe("x");
  });
});
