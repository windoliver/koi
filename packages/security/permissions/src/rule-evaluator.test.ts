import { describe, expect, test } from "bun:test";

import type { PermissionQuery } from "@koi/core";

import { evaluateRules, matchGlob } from "./rule-evaluator.js";
import type { SourcedRule } from "./rule-types.js";

// ---------------------------------------------------------------------------
// matchGlob
// ---------------------------------------------------------------------------

describe("matchGlob", () => {
  test("exact path match", () => {
    expect(matchGlob("src/index.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("src/index.ts", "src/other.ts")).toBe(false);
  });

  test("single star matches one segment", () => {
    expect(matchGlob("src/*.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/deep/index.ts")).toBe(false);
  });

  test("double star matches nested paths", () => {
    expect(matchGlob("src/**/*.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("src/**/*.ts", "src/deep/nested/index.ts")).toBe(true);
    expect(matchGlob("src/**", "src/a/b/c")).toBe(true);
  });

  test("double star at start matches everything", () => {
    expect(matchGlob("**/*.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("**", "anything/at/all")).toBe(true);
  });

  test("escapes regex special characters", () => {
    expect(matchGlob("file.ts", "file.ts")).toBe(true);
    expect(matchGlob("file.ts", "filexts")).toBe(false);
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
    const rules: readonly SourcedRule[] = [
      { pattern: "src/**", action: "write", effect: "allow", source: "project" },
    ];
    expect(evaluateRules(query, rules)).toEqual({ effect: "allow" });
  });

  test("returns deny with reason for matching deny rule", () => {
    const rules: readonly SourcedRule[] = [
      { pattern: "src/**", action: "write", effect: "deny", reason: "read-only", source: "policy" },
    ];
    expect(evaluateRules(query, rules)).toEqual({ effect: "deny", reason: "read-only" });
  });

  test("returns ask with default reason when deny rule has no reason", () => {
    const rules: readonly SourcedRule[] = [
      { pattern: "src/**", action: "write", effect: "ask", source: "project" },
    ];
    const decision = evaluateRules(query, rules);
    expect(decision.effect).toBe("ask");
    expect("reason" in decision && decision.reason).toContain("project rule");
  });

  test("first matching rule wins", () => {
    const rules: readonly SourcedRule[] = [
      { pattern: "src/**", action: "write", effect: "deny", reason: "first", source: "policy" },
      { pattern: "src/**", action: "write", effect: "allow", source: "user" },
    ];
    expect(evaluateRules(query, rules)).toEqual({ effect: "deny", reason: "first" });
  });

  test("wildcard action matches any action", () => {
    const rules: readonly SourcedRule[] = [
      { pattern: "src/**", action: "*", effect: "allow", source: "project" },
    ];
    expect(evaluateRules(query, rules)).toEqual({ effect: "allow" });
  });

  test("non-matching action is skipped", () => {
    const rules: readonly SourcedRule[] = [
      { pattern: "src/**", action: "read", effect: "allow", source: "project" },
    ];
    const decision = evaluateRules(query, rules);
    expect(decision.effect).toBe("ask");
  });

  test("no matching rules returns ask fallback", () => {
    const decision = evaluateRules(query, []);
    expect(decision).toEqual({ effect: "ask", reason: "No matching permission rule" });
  });

  test("non-matching pattern is skipped", () => {
    const rules: readonly SourcedRule[] = [
      { pattern: "lib/**", action: "write", effect: "allow", source: "project" },
    ];
    const decision = evaluateRules(query, rules);
    expect(decision.effect).toBe("ask");
  });
});
