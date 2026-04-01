import { describe, expect, test } from "bun:test";
import { loadRules } from "./rule-loader.js";
import type { PermissionRule, RuleSource } from "./rule-types.js";

describe("loadRules", () => {
  test("merges sources in precedence order", () => {
    const sources = new Map<RuleSource, readonly PermissionRule[]>([
      ["user", [{ pattern: "**", action: "*", effect: "allow" }]],
      ["policy", [{ pattern: "/etc/**", action: "*", effect: "deny", reason: "system" }]],
      ["project", [{ pattern: "src/**", action: "write", effect: "allow" }]],
    ]);

    const result = loadRules(sources);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Policy first, then project, then user
    expect(result.value[0]?.source).toBe("policy");
    expect(result.value[1]?.source).toBe("project");
    expect(result.value[2]?.source).toBe("user");
  });

  test("tags each rule with its source and compiles glob", () => {
    const sources = new Map<RuleSource, readonly PermissionRule[]>([
      ["project", [{ pattern: "src/**", action: "read", effect: "allow" }]],
    ]);

    const result = loadRules(sources);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value[0]?.source).toBe("project");
    expect(result.value[0]?.pattern).toBe("src/**");
    expect(result.value[0]?.compiled).toBeInstanceOf(RegExp);
  });

  test("returns empty array for empty sources", () => {
    const result = loadRules(new Map());
    expect(result).toEqual({ ok: true, value: [] });
  });

  test("skips sources with empty rule arrays", () => {
    const sources = new Map<RuleSource, readonly PermissionRule[]>([
      ["policy", []],
      ["user", [{ pattern: "**", action: "*", effect: "allow" }]],
    ]);

    const result = loadRules(sources);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.source).toBe("user");
  });

  test("returns error for invalid rules", () => {
    const sources = new Map<RuleSource, readonly PermissionRule[]>([
      ["project", [{ pattern: "", action: "read", effect: "allow" }]],
    ]);

    const result = loadRules(sources);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("VALIDATION");
  });

  test("returns error for invalid effect value", () => {
    const sources = new Map<RuleSource, readonly PermissionRule[]>([
      ["project", [{ pattern: "**", action: "read", effect: "maybe" as "allow" }]],
    ]);

    const result = loadRules(sources);
    expect(result.ok).toBe(false);
  });

  test("returns error for invalid glob pattern", () => {
    const sources = new Map<RuleSource, readonly PermissionRule[]>([
      ["project", [{ pattern: "[invalid", action: "read", effect: "allow" }]],
    ]);

    const result = loadRules(sources);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("Invalid glob pattern");
  });

  test("preserves rule order within a source", () => {
    const sources = new Map<RuleSource, readonly PermissionRule[]>([
      [
        "project",
        [
          { pattern: "src/secret/**", action: "write", effect: "deny", reason: "secret" },
          { pattern: "src/**", action: "write", effect: "allow" },
        ],
      ],
    ]);

    const result = loadRules(sources);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value[0]?.reason).toBe("secret");
    expect(result.value[1]?.effect).toBe("allow");
  });
});
