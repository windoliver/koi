import { describe, expect, test } from "bun:test";

import type { PermissionQuery } from "@koi/core";

import { compileGlob, evaluateRules } from "./rule-evaluator.js";
import type { CompiledRule } from "./rule-types.js";

function makeRule(
  pattern: string,
  action: string,
  effect: "allow" | "deny" | "ask",
  source: "policy" | "project" | "local" | "user" = "project",
  reason?: string,
): CompiledRule {
  return { pattern, action, effect, source, reason, compiled: compileGlob(pattern) };
}

// ---------------------------------------------------------------------------
// compileGlob
// ---------------------------------------------------------------------------

describe("compileGlob", () => {
  test("exact path match", () => {
    const re = compileGlob("src/index.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/other.ts")).toBe(false);
  });

  test("single star matches one segment", () => {
    const re = compileGlob("src/*.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/deep/index.ts")).toBe(false);
  });

  test("double star matches nested paths", () => {
    const re = compileGlob("src/**/*.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/deep/nested/index.ts")).toBe(true);
  });

  test("double star alone matches everything below", () => {
    const re = compileGlob("src/**");
    expect(re.test("src/a/b/c")).toBe(true);
  });

  test("double star at start matches everything", () => {
    const re = compileGlob("**/*.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("index.ts")).toBe(true);
  });

  test("escapes regex special characters", () => {
    const re = compileGlob("file.ts");
    expect(re.test("file.ts")).toBe(true);
    expect(re.test("filexts")).toBe(false);
  });

  test("throws on invalid regex pattern", () => {
    // Unbalanced bracket produces invalid regex
    expect(() => compileGlob("[invalid")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// evaluateRules
// ---------------------------------------------------------------------------

describe("evaluateRules", () => {
  const query: PermissionQuery = {
    principal: "agent-1",
    action: "write",
    resource: "src/index.ts",
  };

  test("returns allow for matching allow rule", () => {
    const rules = [makeRule("src/**", "write", "allow")];
    expect(evaluateRules(query, rules)).toEqual({ effect: "allow" });
  });

  test("returns deny with reason for matching deny rule", () => {
    const rules = [makeRule("src/**", "write", "deny", "policy", "read-only")];
    expect(evaluateRules(query, rules)).toEqual({ effect: "deny", reason: "read-only" });
  });

  test("returns ask with default reason when rule has no reason", () => {
    const rules = [makeRule("src/**", "write", "ask")];
    const decision = evaluateRules(query, rules);
    expect(decision.effect).toBe("ask");
    expect("reason" in decision && decision.reason).toContain("project rule");
  });

  test("first matching rule wins", () => {
    const rules = [
      makeRule("src/**", "write", "deny", "policy", "first"),
      makeRule("src/**", "write", "allow", "user"),
    ];
    expect(evaluateRules(query, rules)).toEqual({ effect: "deny", reason: "first" });
  });

  test("wildcard action matches any action", () => {
    const rules = [makeRule("src/**", "*", "allow")];
    expect(evaluateRules(query, rules)).toEqual({ effect: "allow" });
  });

  test("non-matching action is skipped", () => {
    const rules = [makeRule("src/**", "read", "allow")];
    const decision = evaluateRules(query, rules);
    expect(decision.effect).toBe("ask");
  });

  test("no matching rules returns ask fallback", () => {
    const decision = evaluateRules(query, []);
    expect(decision).toEqual({ effect: "ask", reason: "No matching permission rule" });
  });

  test("non-matching pattern is skipped", () => {
    const rules = [makeRule("lib/**", "write", "allow")];
    const decision = evaluateRules(query, rules);
    expect(decision.effect).toBe("ask");
  });
});
