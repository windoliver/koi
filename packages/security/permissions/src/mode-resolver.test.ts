import { describe, expect, test } from "bun:test";

import type { PermissionQuery } from "@koi/core";
import { resolveMode } from "./mode-resolver.js";
import { compileGlob } from "./rule-evaluator.js";
import type { CompiledRule } from "./rule-types.js";

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

const invokeQuery: PermissionQuery = {
  principal: "agent-1",
  action: "invoke",
  resource: "some-tool",
};

const discoverQuery: PermissionQuery = {
  principal: "agent-1",
  action: "discover",
  resource: "tools",
};

const rules: readonly CompiledRule[] = [
  {
    pattern: "src/**",
    action: "write",
    effect: "allow",
    source: "project",
    compiled: compileGlob("src/**"),
  },
  {
    pattern: "src/**",
    action: "read",
    effect: "allow",
    source: "project",
    compiled: compileGlob("src/**"),
  },
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
    test("allows read actions when rules explicitly allow", () => {
      expect(resolveMode("plan", readQuery, rules)).toEqual({ effect: "allow" });
    });

    test("returns ask for read actions when no rule matches", () => {
      const decision = resolveMode("plan", readQuery, []);
      expect(decision.effect).toBe("ask");
    });

    test("denies discover actions (not in allowlist)", () => {
      const decision = resolveMode("plan", discoverQuery, rules);
      expect(decision.effect).toBe("deny");
    });

    test("denies write actions", () => {
      const decision = resolveMode("plan", writeQuery, rules);
      expect(decision.effect).toBe("deny");
    });

    test("denies bash actions", () => {
      const decision = resolveMode("plan", bashQuery, rules);
      expect(decision.effect).toBe("deny");
    });

    test("honors policy deny rules even for read actions", () => {
      const denyReadRules: readonly CompiledRule[] = [
        {
          pattern: "/etc/**",
          action: "read",
          effect: "deny",
          reason: "system files",
          source: "policy",
          compiled: compileGlob("/etc/**"),
        },
      ];
      const etcReadQuery: PermissionQuery = {
        principal: "agent-1",
        action: "read",
        resource: "/etc/passwd",
      };
      expect(resolveMode("plan", etcReadQuery, denyReadRules)).toEqual({
        effect: "deny",
        reason: "system files",
      });
    });

    test("denies unknown actions (deny-by-default)", () => {
      const decision = resolveMode("plan", invokeQuery, rules);
      expect(decision.effect).toBe("deny");
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
      const denyRules: readonly CompiledRule[] = [
        {
          pattern: "src/**",
          action: "write",
          effect: "deny",
          reason: "locked",
          source: "policy",
          compiled: compileGlob("src/**"),
        },
      ];
      expect(resolveMode("auto", writeQuery, denyRules)).toEqual({
        effect: "deny",
        reason: "locked",
      });
    });

    test("falls back to ask when no rule matches", () => {
      const decision = resolveMode("auto", writeQuery, []);
      expect(decision.effect).toBe("ask");
    });

    test("returns allow for matching allow rule", () => {
      expect(resolveMode("auto", writeQuery, rules)).toEqual({ effect: "allow" });
    });
  });
});
