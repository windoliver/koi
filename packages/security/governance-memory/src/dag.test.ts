/**
 * Tests for the constraint DAG — topological sort, cycle detection, validation.
 */

import { describe, expect, test } from "bun:test";
import { createConstraintDag } from "./dag.js";
import type { GovernanceRule } from "./types.js";

function makeRule(overrides: Partial<GovernanceRule> & { readonly id: string }): GovernanceRule {
  return {
    effect: "permit",
    priority: 0,
    condition: () => true,
    message: `Rule ${overrides.id}`,
    ...overrides,
  };
}

describe("createConstraintDag", () => {
  test("empty rules → empty DAG", () => {
    const dag = createConstraintDag([]);
    expect(dag.sortedRules).toHaveLength(0);
    expect(dag.dependencyMap.size).toBe(0);
  });

  test("single rule → single-element DAG", () => {
    const rules = [makeRule({ id: "r1" })];
    const dag = createConstraintDag(rules);
    expect(dag.sortedRules).toHaveLength(1);
    expect(dag.sortedRules[0]?.id).toBe("r1");
  });

  test("independent rules → sorted by priority", () => {
    const rules = [
      makeRule({ id: "r2", priority: 2 }),
      makeRule({ id: "r1", priority: 1 }),
      makeRule({ id: "r3", priority: 3 }),
    ];
    const dag = createConstraintDag(rules);
    expect(dag.sortedRules.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  test("linear dependency chain → evaluates in order", () => {
    const rules = [
      makeRule({ id: "r3", priority: 0, dependsOn: ["r2"] }),
      makeRule({ id: "r1", priority: 0 }),
      makeRule({ id: "r2", priority: 0, dependsOn: ["r1"] }),
    ];
    const dag = createConstraintDag(rules);
    const ids = dag.sortedRules.map((r) => r.id);
    expect(ids.indexOf("r1")).toBeLessThan(ids.indexOf("r2"));
    expect(ids.indexOf("r2")).toBeLessThan(ids.indexOf("r3"));
  });

  test("diamond dependency → both paths resolve", () => {
    // r1 → r2 → r4
    // r1 → r3 → r4
    const rules = [
      makeRule({ id: "r1", priority: 0 }),
      makeRule({ id: "r2", priority: 0, dependsOn: ["r1"] }),
      makeRule({ id: "r3", priority: 0, dependsOn: ["r1"] }),
      makeRule({ id: "r4", priority: 0, dependsOn: ["r2", "r3"] }),
    ];
    const dag = createConstraintDag(rules);
    const ids = dag.sortedRules.map((r) => r.id);
    expect(ids.indexOf("r1")).toBeLessThan(ids.indexOf("r2"));
    expect(ids.indexOf("r1")).toBeLessThan(ids.indexOf("r3"));
    expect(ids.indexOf("r2")).toBeLessThan(ids.indexOf("r4"));
    expect(ids.indexOf("r3")).toBeLessThan(ids.indexOf("r4"));
  });

  test("cycle detection → throws VALIDATION error", () => {
    const rules = [
      makeRule({ id: "r1", dependsOn: ["r2"] }),
      makeRule({ id: "r2", dependsOn: ["r1"] }),
    ];
    expect(() => createConstraintDag(rules)).toThrow(/[Cc]ycle/);
  });

  test("three-node cycle → throws VALIDATION error", () => {
    const rules = [
      makeRule({ id: "r1", dependsOn: ["r3"] }),
      makeRule({ id: "r2", dependsOn: ["r1"] }),
      makeRule({ id: "r3", dependsOn: ["r2"] }),
    ];
    expect(() => createConstraintDag(rules)).toThrow(/[Cc]ycle/);
  });

  test("unknown dependsOn reference → throws VALIDATION error", () => {
    const rules = [makeRule({ id: "r1", dependsOn: ["nonexistent"] })];
    expect(() => createConstraintDag(rules)).toThrow(/unknown rule/);
  });

  test("duplicate rule IDs → throws VALIDATION error", () => {
    const rules = [makeRule({ id: "r1" }), makeRule({ id: "r1" })];
    expect(() => createConstraintDag(rules)).toThrow(/[Dd]uplicate/);
  });

  test("sortedRules is frozen", () => {
    const rules = [makeRule({ id: "r1" })];
    const dag = createConstraintDag(rules);
    expect(Object.isFrozen(dag.sortedRules)).toBe(true);
  });

  test("dependencyMap is populated correctly", () => {
    const rules = [makeRule({ id: "r1" }), makeRule({ id: "r2", dependsOn: ["r1"] })];
    const dag = createConstraintDag(rules);
    expect(dag.dependencyMap.get("r1")).toEqual([]);
    expect(dag.dependencyMap.get("r2")).toEqual(["r1"]);
  });
});
