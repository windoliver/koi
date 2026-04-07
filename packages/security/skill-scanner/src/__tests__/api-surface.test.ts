/**
 * API surface smoke test — verifies all public exports are defined at import time.
 * This is a contract test: if any export is accidentally deleted or renamed, this fails.
 */
import { describe, expect, test } from "bun:test";
import * as skillScanner from "../index.js";

describe("@koi/skill-scanner public API surface", () => {
  test("createScanner is exported and callable", () => {
    expect(typeof skillScanner.createScanner).toBe("function");
    const scanner = skillScanner.createScanner();
    expect(typeof scanner.scan).toBe("function");
    expect(typeof scanner.scanSkill).toBe("function");
  });

  test("getBuiltinRules is exported and returns non-empty array", () => {
    expect(typeof skillScanner.getBuiltinRules).toBe("function");
    const rules = skillScanner.getBuiltinRules();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
  });

  test("getTextRules is exported and returns non-empty array", () => {
    expect(typeof skillScanner.getTextRules).toBe("function");
    const rules = skillScanner.getTextRules();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
  });

  test("getServerRules is exported", () => {
    expect(typeof skillScanner.getServerRules).toBe("function");
    const rules = skillScanner.getServerRules();
    expect(Array.isArray(rules)).toBe(true);
  });

  test("getRulesByCategory is exported and filters correctly", () => {
    expect(typeof skillScanner.getRulesByCategory).toBe("function");
    const dangerousRules = skillScanner.getRulesByCategory("DANGEROUS_API");
    expect(dangerousRules.length).toBeGreaterThan(0);
    expect(dangerousRules.every((r) => r.category === "DANGEROUS_API")).toBe(true);
  });

  test("all builtin rules have required fields", () => {
    const rules = skillScanner.getBuiltinRules();
    for (const rule of rules) {
      expect(typeof rule.name).toBe("string");
      expect(rule.name.length).toBeGreaterThan(0);
      expect(typeof rule.category).toBe("string");
      expect(typeof rule.defaultSeverity).toBe("string");
      expect(typeof rule.check).toBe("function");
    }
  });

  test("scan() returns a ScanReport with the expected shape", () => {
    const scanner = skillScanner.createScanner();
    const report = scanner.scan("const x = 1;");
    expect(typeof report.durationMs).toBe("number");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof report.rulesApplied).toBe("number");
    expect(report.rulesApplied).toBeGreaterThan(0);
    expect(typeof report.parseErrors).toBe("number");
    expect(Array.isArray(report.findings)).toBe(true);
  });

  test("scanSkill() returns a ScanReport with the expected shape", () => {
    const scanner = skillScanner.createScanner();
    const report = scanner.scanSkill("# Skill\n\n```ts\nconst x = 1;\n```");
    expect(typeof report.durationMs).toBe("number");
    expect(Array.isArray(report.findings)).toBe(true);
  });
});
