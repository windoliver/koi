import { describe, expect, test } from "bun:test";

import type { PermissionBackend, PermissionQuery } from "@koi/core";

import { createPermissionBackend } from "./create-permission-backend.js";
import { compileGlob } from "./rule-evaluator.js";
import type { PermissionConfig } from "./rule-types.js";

const config: PermissionConfig = {
  mode: "default",
  rules: [
    {
      pattern: "src/**",
      action: "write",
      effect: "allow",
      source: "project",
      compiled: compileGlob("src/**"),
    },
    {
      pattern: "/etc/**",
      action: "*",
      effect: "deny",
      reason: "system files",
      source: "policy",
      compiled: compileGlob("/etc/**"),
    },
  ],
};

describe("createPermissionBackend", () => {
  test("satisfies PermissionBackend contract", () => {
    const backend: PermissionBackend = createPermissionBackend(config);
    expect(typeof backend.check).toBe("function");
    expect(typeof backend.checkBatch).toBe("function");
    expect(typeof backend.dispose).toBe("function");
  });

  test("check returns allow for matching allow rule", async () => {
    const backend = createPermissionBackend(config);
    const query: PermissionQuery = {
      principal: "agent-1",
      action: "write",
      resource: "src/index.ts",
    };
    expect(await backend.check(query)).toEqual({ effect: "allow" });
  });

  test("check returns deny for matching deny rule", async () => {
    const backend = createPermissionBackend(config);
    const query: PermissionQuery = {
      principal: "agent-1",
      action: "read",
      resource: "/etc/passwd",
    };
    expect(await backend.check(query)).toEqual({ effect: "deny", reason: "system files" });
  });

  test("check returns ask when no rule matches", async () => {
    const backend = createPermissionBackend(config);
    const query: PermissionQuery = {
      principal: "agent-1",
      action: "delete",
      resource: "tmp/file.txt",
    };
    const decision = await backend.check(query);
    expect(decision.effect).toBe("ask");
  });

  test("checkBatch processes multiple queries", async () => {
    const backend = createPermissionBackend(config);
    const queries: readonly PermissionQuery[] = [
      { principal: "agent-1", action: "write", resource: "src/index.ts" },
      { principal: "agent-1", action: "read", resource: "/etc/passwd" },
    ];
    const decisions = await backend.checkBatch?.(queries);
    expect(decisions).toBeDefined();
    expect(decisions).toHaveLength(2);
    expect(decisions?.[0]).toEqual({ effect: "allow" });
    expect(decisions?.[1]).toEqual({ effect: "deny", reason: "system files" });
  });

  test("dispose is callable without error", async () => {
    const backend = createPermissionBackend(config);
    await backend.dispose?.();
  });

  test("bypass mode always allows", async () => {
    const backend = createPermissionBackend({ mode: "bypass", rules: [] });
    const query: PermissionQuery = {
      principal: "agent-1",
      action: "delete",
      resource: "/etc/passwd",
    };
    expect(await backend.check(query)).toEqual({ effect: "allow" });
  });

  test("throws on invalid mode at construction time", () => {
    expect(() => createPermissionBackend({ mode: "invalid" as "default", rules: [] })).toThrow(
      "Invalid permission mode",
    );
  });

  test("custom planAllowedActions extends plan mode vocabulary", async () => {
    const backend = createPermissionBackend({
      mode: "plan",
      rules: [
        {
          pattern: "**",
          action: "metadata",
          effect: "allow",
          source: "project",
          compiled: compileGlob("**"),
        },
      ],
      planAllowedActions: new Set(["read", "metadata"]),
    });
    const query: PermissionQuery = {
      principal: "agent-1",
      action: "metadata",
      resource: "src/index.ts",
    };
    expect(await backend.check(query)).toEqual({ effect: "allow" });
  });

  test("rejects mutating actions in planAllowedActions", () => {
    expect(() =>
      createPermissionBackend({
        mode: "plan",
        rules: [],
        planAllowedActions: new Set(["read", "write"]),
      }),
    ).toThrow('Mutating action "write" cannot be added to planAllowedActions');
  });

  test("rejects mutating actions in planRuleEvaluatedActions", () => {
    expect(() =>
      createPermissionBackend({
        mode: "plan",
        rules: [],
        planRuleEvaluatedActions: new Set(["discover", "bash"]),
      }),
    ).toThrow('Mutating action "bash" cannot be added to planRuleEvaluatedActions');
  });
});
