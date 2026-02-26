/**
 * Unit tests for the built-in rule registry.
 *
 * Verifies registry completeness: 30 rules, all unique names,
 * all 5 categories, and all 10 OWASP IDs represented.
 */

import { describe, expect, test } from "bun:test";
import type { DoctorCategory, OwaspAgenticId } from "../types.js";
import { getBuiltinRules } from "./index.js";

describe("getBuiltinRules", () => {
  const rules = getBuiltinRules();

  test("returns exactly 30 rules", () => {
    expect(rules).toHaveLength(30);
  });

  test("all rule names are unique", () => {
    const names = rules.map((r) => r.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(30);
  });

  test("all 5 categories are represented", () => {
    const categories = new Set(rules.map((r) => r.category));
    const expectedCategories: readonly DoctorCategory[] = [
      "GOAL_INTEGRITY",
      "TOOL_SAFETY",
      "ACCESS_CONTROL",
      "SUPPLY_CHAIN",
      "RESILIENCE",
    ];
    for (const cat of expectedCategories) {
      expect(categories.has(cat)).toBe(true);
    }
    expect(categories.size).toBe(5);
  });

  test("all 10 OWASP Agentic IDs are represented", () => {
    const owaspIds = new Set<OwaspAgenticId>();
    for (const rule of rules) {
      for (const id of rule.owasp) {
        owaspIds.add(id);
      }
    }
    const expectedIds: readonly OwaspAgenticId[] = [
      "ASI01",
      "ASI02",
      "ASI03",
      "ASI04",
      "ASI05",
      "ASI06",
      "ASI07",
      "ASI08",
      "ASI09",
      "ASI10",
    ];
    for (const id of expectedIds) {
      expect(owaspIds.has(id)).toBe(true);
    }
    expect(owaspIds.size).toBe(10);
  });

  test("every rule has a non-empty name", () => {
    for (const rule of rules) {
      expect(rule.name.length).toBeGreaterThan(0);
    }
  });

  test("every rule has a check function", () => {
    for (const rule of rules) {
      expect(typeof rule.check).toBe("function");
    }
  });

  test("every rule has at least one OWASP ID", () => {
    for (const rule of rules) {
      expect(rule.owasp.length).toBeGreaterThan(0);
    }
  });

  test("every rule has a valid severity", () => {
    const validSeverities = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);
    for (const rule of rules) {
      expect(validSeverities.has(rule.defaultSeverity)).toBe(true);
    }
  });

  test("returns the same array reference on repeated calls", () => {
    const first = getBuiltinRules();
    const second = getBuiltinRules();
    expect(first).toBe(second);
  });

  test("contains expected rule name prefixes across all categories", () => {
    const names = rules.map((r) => r.name);
    const expectedPrefixes = [
      "goal-hijack:",
      "tool-misuse:",
      "code-execution:",
      "privilege-abuse:",
      "insecure-delegation:",
      "supply-chain:",
      "memory-poisoning:",
      "cascading-failures:",
      "human-trust:",
      "rogue-agents:",
    ];
    for (const prefix of expectedPrefixes) {
      const matching = names.filter((n) => n.startsWith(prefix));
      expect(matching.length).toBeGreaterThan(0);
    }
  });
});
