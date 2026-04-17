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

  test("compiles patterns with special characters as literals", () => {
    const sources = new Map<RuleSource, readonly PermissionRule[]>([
      ["project", [{ pattern: "[invalid", action: "read", effect: "allow" }]],
    ]);

    const result = loadRules(sources);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Pattern passes through as-is (compilation happens in createPermissionBackend)
    expect(result.value[0]?.pattern).toBe("[invalid");
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

  test("normalizes backslashes in rule patterns", () => {
    const sources = new Map<RuleSource, readonly PermissionRule[]>([
      ["policy", [{ pattern: "C:\\secret\\**", action: "*", effect: "deny", reason: "secret" }]],
    ]);

    const result = loadRules(sources);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Pattern should be normalized to forward slashes
    expect(result.value[0]?.pattern).toBe("C:/secret/**");
  });
});

describe("loadRules on_deny round-trip (#1650)", () => {
  test("preserves on_deny: 'hard' for policy-tier", () => {
    const input = new Map([
      [
        "policy" as const,
        [
          {
            pattern: "/etc/**",
            action: "write",
            effect: "deny" as const,
            on_deny: "hard" as const,
          },
        ],
      ],
    ]);
    const result = loadRules(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]?.on_deny).toBe("hard");
  });

  test("preserves on_deny: 'soft' for project-tier", () => {
    const input = new Map([
      [
        "project" as const,
        [
          {
            pattern: "/tmp/scratch/**",
            action: "write",
            effect: "deny" as const,
            on_deny: "soft" as const,
          },
        ],
      ],
    ]);
    const result = loadRules(input);
    if (result.ok) expect(result.value[0]?.on_deny).toBe("soft");
  });

  test("preserves on_deny across all four source tiers", () => {
    const tiers = ["policy", "project", "local", "user"] as const;
    for (const tier of tiers) {
      const input = new Map([
        [tier, [{ pattern: "x", action: "y", effect: "deny" as const, on_deny: "soft" as const }]],
      ]);
      const result = loadRules(input);
      if (!result.ok) throw new Error(`failed for tier ${tier}`);
      expect(result.value[0]?.on_deny).toBe("soft");
    }
  });

  test("rule without on_deny loads cleanly (backward compat)", () => {
    const input = new Map([
      ["project" as const, [{ pattern: "/x", action: "read", effect: "allow" as const }]],
    ]);
    const result = loadRules(input);
    if (result.ok) expect(result.value[0]?.on_deny).toBeUndefined();
  });
});
