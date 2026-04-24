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

describe("DSL sugar — Write/Read/Network rule shapes", () => {
  test("parses Write rule into action:write + pattern", () => {
    const result = loadRules(
      new Map([
        [
          "policy",
          [
            {
              Write: "/etc/**",
              effect: "deny",
              reason: "no writes to /etc",
            } as unknown as PermissionRule,
          ],
        ],
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.action).toBe("write");
    expect(result.value[0]?.pattern).toBe("/etc/**");
    expect(result.value[0]?.effect).toBe("deny");
    expect(result.value[0]?.reason).toBe("no writes to /etc");
  });

  test("parses Read rule into action:read + pattern", () => {
    const result = loadRules(
      new Map([["user", [{ Read: "/secret/*", effect: "deny" } as unknown as PermissionRule]]]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.action).toBe("read");
    expect(result.value[0]?.pattern).toBe("/secret/*");
  });

  test("parses Network rule into action:network + pattern", () => {
    const result = loadRules(
      new Map([["policy", [{ Network: "evil.com", effect: "deny" } as unknown as PermissionRule]]]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.action).toBe("network");
    expect(result.value[0]?.pattern).toBe("evil.com");
  });

  test("rejects object with unknown DSL key", () => {
    const result = loadRules(
      new Map([["user", [{ Delete: "/tmp", effect: "deny" } as unknown as PermissionRule]]]),
    );
    expect(result.ok).toBe(false);
  });

  test("flat rules still load unchanged alongside DSL rules", () => {
    const rules = [
      { pattern: "bash:rm", action: "*", effect: "deny" } as PermissionRule,
      { Write: "/tmp/**", effect: "allow" } as unknown as PermissionRule,
    ];
    const result = loadRules(new Map([["user", rules]]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value[0]?.pattern).toBe("bash:rm");
    expect(result.value[1]?.action).toBe("write");
    expect(result.value[1]?.pattern).toBe("/tmp/**");
  });

  test("Write DSL rule respects on_deny field", () => {
    const result = loadRules(
      new Map([
        [
          "policy",
          [{ Write: "/etc/**", effect: "deny", on_deny: "soft" } as unknown as PermissionRule],
        ],
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.on_deny).toBe("soft");
  });

  test("flat rule with extra legacy metadata fields still loads (no .strict())", () => {
    // Existing policy files may carry extra fields like description, tags, owner, etc.
    // These are unknown to the schema and should be silently stripped, not rejected.
    const result = loadRules(
      new Map([
        [
          "project" as const,
          [
            {
              pattern: "bash:rm",
              action: "*",
              effect: "deny",
              reason: "destructive",
              description: "legacy metadata",
              owner: "security-team",
            } as unknown as PermissionRule,
          ],
        ],
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.pattern).toBe("bash:rm");
    expect(result.value[0]?.effect).toBe("deny");
  });

  test("flat rule with a DSL key value is rejected (ambiguity guard)", () => {
    // { Write: "/etc/**", pattern: "bash:*", effect: "deny" } must fail —
    // without explicit rejection, Zod would strip Write and misroute the rule.
    const result = loadRules(
      new Map([
        [
          "policy" as const,
          [
            {
              Write: "/etc/**",
              pattern: "bash:*",
              effect: "deny",
            } as unknown as PermissionRule,
          ],
        ],
      ]),
    );
    expect(result.ok).toBe(false);
  });

  test("rejects ambiguous rule with two DSL keys (Write + Read together)", () => {
    // { Write: ..., Read: ..., effect: "deny" } is ambiguous — strict schemas ensure
    // neither branch silently discards the extra key, so validation rejects it.
    const result = loadRules(
      new Map([
        [
          "policy",
          [
            {
              Write: "/etc/**",
              Read: "/secret/**",
              effect: "deny",
            } as unknown as PermissionRule,
          ],
        ],
      ]),
    );
    expect(result.ok).toBe(false);
  });

  test("Network DSL rule with principal field", () => {
    const result = loadRules(
      new Map([
        [
          "policy",
          [
            {
              Network: "evil.com",
              effect: "deny",
              principal: "agent:*",
            } as unknown as PermissionRule,
          ],
        ],
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.principal).toBe("agent:*");
    expect(result.value[0]?.action).toBe("network");
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
