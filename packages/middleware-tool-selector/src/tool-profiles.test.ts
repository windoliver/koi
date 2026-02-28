import { describe, expect, test } from "bun:test";
import { isToolProfileName, TOOL_PROFILES } from "./tool-profiles.js";

describe("TOOL_PROFILES", () => {
  test("contains all 6 expected profiles", () => {
    expect(Object.keys(TOOL_PROFILES)).toEqual([
      "minimal",
      "coding",
      "research",
      "automation",
      "conversation",
      "full",
    ]);
  });

  test("full profile is an empty array (no filtering)", () => {
    expect(TOOL_PROFILES.full).toEqual([]);
  });

  test("coding profile has 7 tools", () => {
    expect(TOOL_PROFILES.coding).toHaveLength(7);
  });

  test("profiles are readonly arrays", () => {
    expect(Array.isArray(TOOL_PROFILES.minimal)).toBe(true);
    expect(Array.isArray(TOOL_PROFILES.coding)).toBe(true);
  });
});

describe("isToolProfileName", () => {
  test("returns true for valid profile names", () => {
    expect(isToolProfileName("coding")).toBe(true);
    expect(isToolProfileName("minimal")).toBe(true);
    expect(isToolProfileName("full")).toBe(true);
  });

  test("returns false for invalid profile names", () => {
    expect(isToolProfileName("nonexistent")).toBe(false);
    expect(isToolProfileName("")).toBe(false);
    expect(isToolProfileName(42)).toBe(false);
    expect(isToolProfileName(null)).toBe(false);
  });

  test("returns false for 'auto' (auto is not a profile name)", () => {
    expect(isToolProfileName("auto")).toBe(false);
  });
});
