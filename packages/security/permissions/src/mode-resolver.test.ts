import { describe, expect, test } from "bun:test";

import type { PermissionQuery } from "@koi/core";

import { resolveMode } from "./mode-resolver.js";
import type { SourcedRule } from "./rule-types.js";

const readQuery: PermissionQuery = {
  principal: "agent-1",
  action: "read",
  resource: "src/index.ts",
};

const writeQuery: PermissionQuery = {
  principal: "agent-1",
  action: "write",
  resource: "src/index.ts",
};

const bashQuery: PermissionQuery = {
  principal: "agent-1",
  action: "bash",
  resource: "/bin/rm",
};

const rules: readonly SourcedRule[] = [
  { pattern: "src/**", action: "write", effect: "allow", source: "project" },
  { pattern: "src/**", action: "read", effect: "allow", source: "project" },
];

describe("resolveMode", () => {
  describe("bypass", () => {
    test("always allows regardless of query", () => {
      expect(resolveMode("bypass", writeQuery, [])).toEqual({ effect: "allow" });
      expect(resolveMode("bypass", readQuery, [])).toEqual({ effect: "allow" });
      expect(resolveMode("bypass", bashQuery, [])).toEqual({ effect: "allow" });
    });
  });

  describe("plan", () => {
    test("denies write actions", () => {
      const decision = resolveMode("plan", writeQuery, rules);
      expect(decision.effect).toBe("deny");
    });

    test("denies bash actions", () => {
      const decision = resolveMode("plan", bashQuery, rules);
      expect(decision.effect).toBe("deny");
    });

    test("allows read actions", () => {
      expect(resolveMode("plan", readQuery, rules)).toEqual({ effect: "allow" });
    });
  });

  describe("default", () => {
    test("evaluates rules and returns matching decision", () => {
      expect(resolveMode("default", writeQuery, rules)).toEqual({ effect: "allow" });
    });

    test("falls back to ask when no rule matches", () => {
      const decision = resolveMode("default", writeQuery, []);
      expect(decision.effect).toBe("ask");
    });
  });

  describe("auto", () => {
    test("evaluates rules for explicit allow/deny", () => {
      const denyRules: readonly SourcedRule[] = [
        { pattern: "src/**", action: "write", effect: "deny", reason: "locked", source: "policy" },
      ];
      expect(resolveMode("auto", writeQuery, denyRules)).toEqual({
        effect: "deny",
        reason: "locked",
      });
    });

    test("converts ask fallback to allow", () => {
      const decision = resolveMode("auto", writeQuery, []);
      expect(decision).toEqual({ effect: "allow" });
    });

    test("returns allow for matching allow rule", () => {
      expect(resolveMode("auto", writeQuery, rules)).toEqual({ effect: "allow" });
    });
  });
});
