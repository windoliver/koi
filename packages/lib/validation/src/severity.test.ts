import { describe, expect, test } from "bun:test";
import type { Severity } from "./severity.js";
import { SEVERITY_ORDER, severityAtOrAbove } from "./severity.js";

describe("SEVERITY_ORDER", () => {
  test("LOW < MEDIUM < HIGH < CRITICAL", () => {
    expect(SEVERITY_ORDER.LOW).toBeLessThan(SEVERITY_ORDER.MEDIUM);
    expect(SEVERITY_ORDER.MEDIUM).toBeLessThan(SEVERITY_ORDER.HIGH);
    expect(SEVERITY_ORDER.HIGH).toBeLessThan(SEVERITY_ORDER.CRITICAL);
  });
});

describe("severityAtOrAbove", () => {
  test("CRITICAL is at or above every severity", () => {
    const levels: readonly Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    for (const threshold of levels) {
      expect(severityAtOrAbove("CRITICAL", threshold)).toBe(true);
    }
  });

  test("LOW is only at or above LOW", () => {
    expect(severityAtOrAbove("LOW", "LOW")).toBe(true);
    expect(severityAtOrAbove("LOW", "MEDIUM")).toBe(false);
    expect(severityAtOrAbove("LOW", "HIGH")).toBe(false);
    expect(severityAtOrAbove("LOW", "CRITICAL")).toBe(false);
  });

  test("MEDIUM is at or above LOW and MEDIUM", () => {
    expect(severityAtOrAbove("MEDIUM", "LOW")).toBe(true);
    expect(severityAtOrAbove("MEDIUM", "MEDIUM")).toBe(true);
    expect(severityAtOrAbove("MEDIUM", "HIGH")).toBe(false);
    expect(severityAtOrAbove("MEDIUM", "CRITICAL")).toBe(false);
  });

  test("same severity is always at or above itself", () => {
    const levels: readonly Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    for (const s of levels) {
      expect(severityAtOrAbove(s, s)).toBe(true);
    }
  });
});
