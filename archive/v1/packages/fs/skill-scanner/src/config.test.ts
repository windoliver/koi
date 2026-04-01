import { describe, expect, test } from "bun:test";
import { meetsThresholds, resolveConfig, severityAtOrAbove } from "./config.js";

describe("resolveConfig", () => {
  test("returns defaults when no config provided", () => {
    const config = resolveConfig();
    expect(config.enabledCategories).toContain("DANGEROUS_API");
    expect(config.enabledCategories).toContain("OBFUSCATION");
    expect(config.enabledCategories).toContain("EXFILTRATION");
    expect(config.enabledCategories).toContain("PROTOTYPE_POLLUTION");
    expect(config.enabledCategories).toContain("UNPARSEABLE");
    expect(config.severityThreshold).toBe("LOW");
    expect(config.confidenceThreshold).toBe(0.0);
  });

  test("merges partial config with defaults", () => {
    const config = resolveConfig({ severityThreshold: "HIGH" });
    expect(config.severityThreshold).toBe("HIGH");
    expect(config.confidenceThreshold).toBe(0.0); // default
  });

  test("respects enabled categories", () => {
    const config = resolveConfig({ enabledCategories: ["DANGEROUS_API"] });
    expect(config.enabledCategories).toEqual(["DANGEROUS_API"]);
  });
});

describe("severityAtOrAbove", () => {
  test("CRITICAL is at or above all thresholds", () => {
    expect(severityAtOrAbove("CRITICAL", "LOW")).toBe(true);
    expect(severityAtOrAbove("CRITICAL", "MEDIUM")).toBe(true);
    expect(severityAtOrAbove("CRITICAL", "HIGH")).toBe(true);
    expect(severityAtOrAbove("CRITICAL", "CRITICAL")).toBe(true);
  });

  test("LOW is not at or above MEDIUM", () => {
    expect(severityAtOrAbove("LOW", "MEDIUM")).toBe(false);
  });

  test("MEDIUM is at or above LOW", () => {
    expect(severityAtOrAbove("MEDIUM", "LOW")).toBe(true);
  });
});

describe("meetsThresholds", () => {
  test("passes when severity and confidence meet thresholds", () => {
    const config = resolveConfig({ severityThreshold: "MEDIUM", confidenceThreshold: 0.5 });
    expect(meetsThresholds("HIGH", 0.8, config)).toBe(true);
  });

  test("fails when severity is below threshold", () => {
    const config = resolveConfig({ severityThreshold: "HIGH", confidenceThreshold: 0.0 });
    expect(meetsThresholds("MEDIUM", 0.9, config)).toBe(false);
  });

  test("fails when confidence is below threshold", () => {
    const config = resolveConfig({ severityThreshold: "LOW", confidenceThreshold: 0.8 });
    expect(meetsThresholds("CRITICAL", 0.5, config)).toBe(false);
  });
});
