import { describe, expect, test } from "bun:test";
import { meetsThresholds, resolveConfig, severityAtOrAbove } from "./config.js";

describe("resolveConfig", () => {
  test("returns defaults when called with no arguments", () => {
    const cfg = resolveConfig();
    expect(cfg.severityThreshold).toBe("LOW");
    expect(cfg.confidenceThreshold).toBe(0.0);
    expect(cfg.trustedDomains).toEqual([]);
    expect(cfg.onFilteredFinding).toBeUndefined();
    expect(cfg.enabledCategories).toContain("DANGEROUS_API");
    expect(cfg.enabledCategories).toContain("PROMPT_INJECTION");
  });

  test("returns defaults when called with undefined", () => {
    const cfg = resolveConfig(undefined);
    expect(cfg.severityThreshold).toBe("LOW");
    expect(cfg.confidenceThreshold).toBe(0.0);
  });

  test("merges provided values over defaults", () => {
    const cfg = resolveConfig({ severityThreshold: "HIGH", confidenceThreshold: 0.8 });
    expect(cfg.severityThreshold).toBe("HIGH");
    expect(cfg.confidenceThreshold).toBe(0.8);
    // unset fields fall back to defaults
    expect(cfg.trustedDomains).toEqual([]);
  });

  test("accepts custom trustedDomains", () => {
    const cfg = resolveConfig({ trustedDomains: ["example.com"] });
    expect(cfg.trustedDomains).toEqual(["example.com"]);
  });

  test("accepts custom enabledCategories", () => {
    const cfg = resolveConfig({ enabledCategories: ["OBFUSCATION"] });
    expect(cfg.enabledCategories).toEqual(["OBFUSCATION"]);
  });

  test("preserves onFilteredFinding callback", () => {
    const cb = () => {};
    const cfg = resolveConfig({ onFilteredFinding: cb });
    expect(cfg.onFilteredFinding).toBe(cb);
  });
});

describe("severityAtOrAbove", () => {
  test("CRITICAL is at or above CRITICAL", () => {
    expect(severityAtOrAbove("CRITICAL", "CRITICAL")).toBe(true);
  });

  test("CRITICAL is above HIGH", () => {
    expect(severityAtOrAbove("CRITICAL", "HIGH")).toBe(true);
  });

  test("LOW is not above HIGH", () => {
    expect(severityAtOrAbove("LOW", "HIGH")).toBe(false);
  });

  test("LOW is at or above LOW", () => {
    expect(severityAtOrAbove("LOW", "LOW")).toBe(true);
  });

  test("MEDIUM is above LOW but not HIGH", () => {
    expect(severityAtOrAbove("MEDIUM", "LOW")).toBe(true);
    expect(severityAtOrAbove("MEDIUM", "HIGH")).toBe(false);
  });
});

describe("meetsThresholds", () => {
  const cfg = resolveConfig({ severityThreshold: "HIGH", confidenceThreshold: 0.8 });

  test("returns true when severity and confidence both pass", () => {
    expect(meetsThresholds("HIGH", 0.9, cfg)).toBe(true);
    expect(meetsThresholds("CRITICAL", 1.0, cfg)).toBe(true);
  });

  test("returns false when severity is below threshold", () => {
    expect(meetsThresholds("LOW", 0.9, cfg)).toBe(false);
    expect(meetsThresholds("MEDIUM", 1.0, cfg)).toBe(false);
  });

  test("returns false when confidence is below threshold", () => {
    expect(meetsThresholds("CRITICAL", 0.7, cfg)).toBe(false);
  });

  test("returns false when both are below threshold", () => {
    expect(meetsThresholds("LOW", 0.1, cfg)).toBe(false);
  });

  test("returns true at exact threshold boundary values", () => {
    expect(meetsThresholds("HIGH", 0.8, cfg)).toBe(true);
  });
});
