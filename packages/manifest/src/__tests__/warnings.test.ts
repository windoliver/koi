import { describe, expect, test } from "bun:test";
import { levenshteinDistance } from "@koi/validation";
import { detectUnknownFields } from "../warnings.js";

describe("levenshteinDistance", () => {
  test("returns 0 for identical strings", () => {
    expect(levenshteinDistance("model", "model")).toBe(0);
  });

  test("returns length for empty vs non-empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  });

  test("returns 2 for a transposition", () => {
    expect(levenshteinDistance("modle", "model")).toBe(2);
  });

  test("handles insertion", () => {
    expect(levenshteinDistance("tols", "tools")).toBe(1);
  });

  test("returns correct distance for similar words", () => {
    expect(levenshteinDistance("scedule", "schedule")).toBe(1);
  });
});

describe("detectUnknownFields", () => {
  const KNOWN_FIELDS = [
    "name",
    "version",
    "description",
    "model",
    "tools",
    "channels",
    "middleware",
    "permissions",
    "metadata",
    "engine",
    "schedule",
    "webhooks",
    "forge",
  ];

  test("returns empty array for valid fields", () => {
    const warnings = detectUnknownFields({ name: "a", model: "b" }, KNOWN_FIELDS);
    expect(warnings).toEqual([]);
  });

  test("warns on unknown field with no close match", () => {
    const warnings = detectUnknownFields({ name: "a", xyzzy: true }, KNOWN_FIELDS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("xyzzy");
    expect(warnings[0]?.suggestion).toBeUndefined();
  });

  test("suggests close match for typo", () => {
    const warnings = detectUnknownFields({ name: "a", modle: "b" }, KNOWN_FIELDS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("modle");
    expect(warnings[0]?.suggestion).toBe("model");
  });

  test("detects multiple unknown fields", () => {
    const warnings = detectUnknownFields({ name: "a", modle: "b", scedule: "c" }, KNOWN_FIELDS);
    expect(warnings).toHaveLength(2);
    const paths = warnings.map((w) => w.path);
    expect(paths).toContain("modle");
    expect(paths).toContain("scedule");
  });
});
