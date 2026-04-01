import { describe, expect, test } from "bun:test";

import type { PermissionQuery } from "@koi/core";

import { compileGlob, evaluateRules, normalizeResource } from "./rule-evaluator.js";
import type { CompiledRule } from "./rule-types.js";

function makeRule(
  pattern: string,
  action: string,
  effect: "allow" | "deny" | "ask",
  source: "policy" | "project" | "local" | "user" = "project",
  reason?: string,
  principal?: string,
): CompiledRule {
  const compiledPrincipal =
    principal !== undefined && principal !== "*" ? compileGlob(principal) : undefined;
  return {
    pattern,
    action,
    effect,
    source,
    reason,
    principal,
    compiled: compileGlob(pattern),
    compiledPrincipal,
  };
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

  test("**/segment requires path separator boundary", () => {
    const re = compileGlob("foo/**/bar");
    expect(re.test("foo/bar")).toBe(true);
    expect(re.test("foo/a/bar")).toBe(true);
    expect(re.test("foo/a/b/bar")).toBe(true);
    // Must NOT match without separator before "bar"
    expect(re.test("foo/xbar")).toBe(false);
  });

  test("**/ at start requires separator before next segment", () => {
    const re = compileGlob("**/secret.txt");
    expect(re.test("secret.txt")).toBe(true);
    expect(re.test("a/secret.txt")).toBe(true);
    expect(re.test("a/b/secret.txt")).toBe(true);
    expect(re.test("notsecret.txt")).toBe(false);
  });

  test("escapes regex special characters", () => {
    const re = compileGlob("file.ts");
    expect(re.test("file.ts")).toBe(true);
    expect(re.test("filexts")).toBe(false);
  });

  test("escapes ? as literal", () => {
    const re = compileGlob("file?.txt");
    expect(re.test("file?.txt")).toBe(true);
    expect(re.test("fileX.txt")).toBe(false);
  });

  test("escapes [ and ] as literals", () => {
    const re = compileGlob("agent:[prod]");
    expect(re.test("agent:[prod]")).toBe(true);
    expect(re.test("agent:p")).toBe(false);
  });

  test("handles previously-invalid patterns as literals", () => {
    // Unbalanced bracket is now escaped, not a regex error
    const re = compileGlob("[invalid");
    expect(re.test("[invalid")).toBe(true);
    expect(re.test("i")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeResource
// ---------------------------------------------------------------------------

describe("normalizeResource", () => {
  test("resolves .. traversal segments", () => {
    expect(normalizeResource("src/../secrets.env")).toBe("secrets.env");
  });

  test("resolves . segments", () => {
    expect(normalizeResource("src/./index.ts")).toBe("src/index.ts");
  });

  test("collapses double slashes", () => {
    expect(normalizeResource("src//index.ts")).toBe("src/index.ts");
  });

  test("preserves absolute paths", () => {
    expect(normalizeResource("/etc/passwd")).toBe("/etc/passwd");
  });

  test(".. at root collapses to root", () => {
    expect(normalizeResource("/../../etc/passwd")).toBe("/etc/passwd");
  });

  test("non-path resources pass through", () => {
    expect(normalizeResource("agent:foo")).toBe("agent:foo");
  });

  test("nested traversal is fully resolved", () => {
    expect(normalizeResource("src/deep/../../secrets.env")).toBe("secrets.env");
  });

  test("rejects relative paths with leading ..", () => {
    expect(normalizeResource("../secrets.env")).toBeNull();
  });

  test("rejects relative paths that escape via nested ..", () => {
    expect(normalizeResource("src/../../secrets.env")).toBeNull();
  });

  test("absolute paths clamp .. at root", () => {
    expect(normalizeResource("/../../etc/passwd")).toBe("/etc/passwd");
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

  test("path traversal does not bypass allow rules", () => {
    const rules = [makeRule("src/**", "write", "allow")];
    const traversalQuery: PermissionQuery = {
      principal: "agent-1",
      action: "write",
      resource: "src/../secrets.env",
    };
    // After normalization, src/../secrets.env → secrets.env which doesn't match src/**
    const decision = evaluateRules(traversalQuery, rules);
    expect(decision.effect).toBe("ask");
  });

  test("denies relative paths with leading .. traversal", () => {
    const rules = [makeRule("**", "*", "allow")];
    const traversalQuery: PermissionQuery = {
      principal: "agent-1",
      action: "write",
      resource: "../secrets.env",
    };
    const decision = evaluateRules(traversalQuery, rules);
    expect(decision.effect).toBe("deny");
    expect("reason" in decision && decision.reason).toContain("unresolvable traversal");
  });

  test("path traversal does not bypass deny rules", () => {
    const rules = [makeRule("/etc/**", "*", "deny", "policy", "system files")];
    const traversalQuery: PermissionQuery = {
      principal: "agent-1",
      action: "read",
      resource: "/safe/../../etc/passwd",
    };
    // After normalization → /etc/passwd which matches /etc/**
    expect(evaluateRules(traversalQuery, rules)).toEqual({
      effect: "deny",
      reason: "system files",
    });
  });

  test("matches rule when principal matches", () => {
    const rules = [makeRule("src/**", "write", "allow", "project", undefined, "agent-1")];
    expect(evaluateRules(query, rules)).toEqual({ effect: "allow" });
  });

  test("skips rule when principal does not match", () => {
    const rules = [makeRule("src/**", "write", "allow", "project", undefined, "agent-2")];
    const decision = evaluateRules(query, rules);
    expect(decision.effect).toBe("ask");
  });

  test("principal glob matches pattern", () => {
    const rules = [makeRule("src/**", "write", "allow", "project", undefined, "agent-*")];
    expect(evaluateRules(query, rules)).toEqual({ effect: "allow" });
  });

  test("rule without principal matches all principals", () => {
    const rules = [makeRule("src/**", "write", "allow")];
    expect(evaluateRules(query, rules)).toEqual({ effect: "allow" });
  });

  test("principal-scoped deny overrides broad allow", () => {
    const rules = [
      makeRule("src/**", "write", "deny", "policy", "restricted", "agent-1"),
      makeRule("src/**", "write", "allow", "user"),
    ];
    expect(evaluateRules(query, rules)).toEqual({ effect: "deny", reason: "restricted" });
  });
});
