import { describe, expect, test } from "bun:test";
import {
  classifyChangedPaths,
  FIELD_CLASSIFICATION,
  UNCLASSIFIED_SECTIONS,
} from "./classification.js";
import { DEFAULT_KOI_CONFIG } from "./reload.js";

describe("classifyChangedPaths", () => {
  test("classifies top-level hot paths", () => {
    const { hot, restart } = classifyChangedPaths(["logLevel"]);
    expect(hot).toEqual(["logLevel"]);
    expect(restart).toEqual([]);
  });

  test("classifies top-level restart paths", () => {
    const { hot, restart } = classifyChangedPaths(["limits"]);
    expect(hot).toEqual([]);
    expect(restart).toEqual(["limits"]);
  });

  test("longest-prefix match: nested path inherits section class", () => {
    const { hot, restart } = classifyChangedPaths([
      "modelRouter.targets",
      "loopDetection.threshold",
      "limits.maxTurns",
    ]);
    expect([...hot].sort()).toEqual(["loopDetection.threshold", "modelRouter.targets"]);
    expect(restart).toEqual(["limits.maxTurns"]);
  });

  test("fail-closed: unclassified paths default to restart", () => {
    const { hot, restart } = classifyChangedPaths(["spawn.maxDepth", "forge.enabled"]);
    expect(hot).toEqual([]);
    expect([...restart].sort()).toEqual(["forge.enabled", "spawn.maxDepth"]);
  });

  test("fail-closed: paths with no matching prefix default to restart", () => {
    const { hot, restart } = classifyChangedPaths(["totallyUnknown.field"]);
    expect(hot).toEqual([]);
    expect(restart).toEqual(["totallyUnknown.field"]);
  });

  test("mixed hot + restart split correctly", () => {
    const { hot, restart } = classifyChangedPaths([
      "logLevel",
      "telemetry.enabled",
      "features.experimental",
    ]);
    expect([...hot].sort()).toEqual(["features.experimental", "logLevel"]);
    expect(restart).toEqual(["telemetry.enabled"]);
  });

  test("empty input yields empty output", () => {
    const { hot, restart } = classifyChangedPaths([]);
    expect(hot).toEqual([]);
    expect(restart).toEqual([]);
  });
});

describe("FIELD_CLASSIFICATION exhaustiveness", () => {
  test("every top-level section of DEFAULT_KOI_CONFIG is classified or in allowlist", () => {
    const sections = Object.keys(DEFAULT_KOI_CONFIG);
    const unclassified = new Set(UNCLASSIFIED_SECTIONS);
    for (const section of sections) {
      const inTable = Object.hasOwn(FIELD_CLASSIFICATION, section);
      const inAllowlist = unclassified.has(section);
      expect(inTable || inAllowlist).toBe(true);
    }
  });

  test("UNCLASSIFIED_SECTIONS entries are NOT in FIELD_CLASSIFICATION", () => {
    for (const section of UNCLASSIFIED_SECTIONS) {
      expect(Object.hasOwn(FIELD_CLASSIFICATION, section)).toBe(false);
    }
  });

  test("FIELD_CLASSIFICATION values are either 'hot' or 'restart'", () => {
    for (const value of Object.values(FIELD_CLASSIFICATION)) {
      expect(value === "hot" || value === "restart").toBe(true);
    }
  });
});
