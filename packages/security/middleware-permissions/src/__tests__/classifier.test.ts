import { describe, expect, test } from "bun:test";
import type { PermissionDecision } from "@koi/core/permission-backend";
import {
  createAutoApprovalHandler,
  createPatternPermissionBackend,
  DEFAULT_DENY_MARKER,
  DEFAULT_GROUPS,
  isDefaultDeny,
} from "../classifier.js";

function check(
  backend: ReturnType<typeof createPatternPermissionBackend>,
  resource: string,
): PermissionDecision {
  const result = backend.check({
    principal: "agent:test",
    action: "invoke",
    resource,
  });
  // Pattern backend is always sync
  return result as PermissionDecision;
}

describe("createPatternPermissionBackend", () => {
  describe("exact matching", () => {
    const backend = createPatternPermissionBackend({
      rules: { allow: ["multiply"], deny: ["bash"], ask: ["deploy"] },
    });

    test("allows matching tool", () => {
      expect(check(backend, "multiply")).toEqual({ effect: "allow" });
    });

    test("denies matching tool", () => {
      const d = check(backend, "bash");
      expect(d.effect).toBe("deny");
      if (d.effect === "deny") {
        expect(d.reason).toContain("bash");
        expect(d.reason).toContain("denied by policy");
      }
    });

    test("asks for matching tool", () => {
      const d = check(backend, "deploy");
      expect(d.effect).toBe("ask");
      if (d.effect === "ask") {
        expect(d.reason).toContain("deploy");
        expect(d.reason).toContain("requires approval");
      }
    });
  });

  describe("wildcard matching", () => {
    const backend = createPatternPermissionBackend({
      rules: { allow: ["fs:*"], deny: ["db:*"], ask: [] },
    });

    test("allows prefix wildcard match", () => {
      expect(check(backend, "fs:read")).toEqual({ effect: "allow" });
      expect(check(backend, "fs:write")).toEqual({ effect: "allow" });
    });

    test("denies prefix wildcard match", () => {
      expect(check(backend, "db:delete").effect).toBe("deny");
    });

    test("catch-all wildcard matches everything", () => {
      const b = createPatternPermissionBackend({
        rules: { allow: ["*"], deny: [], ask: [] },
      });
      expect(check(b, "anything")).toEqual({ effect: "allow" });
    });
  });

  describe("evaluation order (deny > ask > allow)", () => {
    test("deny wins over ask", () => {
      const b = createPatternPermissionBackend({
        rules: { allow: [], deny: ["deploy"], ask: ["deploy"] },
      });
      expect(check(b, "deploy").effect).toBe("deny");
    });

    test("deny wins over allow", () => {
      const b = createPatternPermissionBackend({
        rules: { allow: ["bash"], deny: ["bash"], ask: [] },
      });
      expect(check(b, "bash").effect).toBe("deny");
    });

    test("ask wins over allow", () => {
      const b = createPatternPermissionBackend({
        rules: { allow: ["deploy"], deny: [], ask: ["deploy"] },
      });
      expect(check(b, "deploy").effect).toBe("ask");
    });
  });

  describe("default deny", () => {
    test("denies unmatched tools by default", () => {
      const b = createPatternPermissionBackend({
        rules: { allow: ["multiply"], deny: [], ask: [] },
      });
      const d = check(b, "unknown_tool");
      expect(d.effect).toBe("deny");
      if (d.effect === "deny") {
        expect(d.reason).toContain(DEFAULT_DENY_MARKER);
      }
    });

    test("allows unmatched tools when defaultDeny=false", () => {
      const b = createPatternPermissionBackend({
        rules: { allow: [], deny: [], ask: [] },
        defaultDeny: false,
      });
      expect(check(b, "anything")).toEqual({ effect: "allow" });
    });
  });

  describe("group expansion", () => {
    test("expands group:fs_read to constituent patterns", () => {
      const b = createPatternPermissionBackend({
        rules: { allow: ["group:fs_read"], deny: [], ask: [] },
        groups: DEFAULT_GROUPS,
      });
      expect(check(b, "fs:read")).toEqual({ effect: "allow" });
      expect(check(b, "fs:stat")).toEqual({ effect: "allow" });
      expect(check(b, "fs_list")).toEqual({ effect: "allow" });
    });

    test("expands group:runtime in deny rules", () => {
      const b = createPatternPermissionBackend({
        rules: { allow: ["*"], deny: ["group:runtime"], ask: [] },
        groups: DEFAULT_GROUPS,
      });
      expect(check(b, "bash").effect).toBe("deny");
      expect(check(b, "exec").effect).toBe("deny");
      expect(check(b, "multiply")).toEqual({ effect: "allow" });
    });

    test("unknown group kept as literal pattern", () => {
      const b = createPatternPermissionBackend({
        rules: { allow: ["group:unknown"], deny: [], ask: [] },
        groups: DEFAULT_GROUPS,
      });
      // "group:unknown" doesn't match anything useful
      expect(check(b, "multiply").effect).toBe("deny");
    });

    test("custom groups work alongside defaults", () => {
      const b = createPatternPermissionBackend({
        rules: { allow: ["group:monitoring"], deny: [], ask: [] },
        groups: { ...DEFAULT_GROUPS, monitoring: ["metrics:*", "logs:*"] },
      });
      expect(check(b, "metrics:cpu")).toEqual({ effect: "allow" });
      expect(check(b, "logs:app")).toEqual({ effect: "allow" });
    });
  });

  describe("DEFAULT_GROUPS", () => {
    test("has 12 built-in groups", () => {
      expect(Object.keys(DEFAULT_GROUPS)).toHaveLength(12);
    });

    test("includes expected groups", () => {
      const keys = Object.keys(DEFAULT_GROUPS);
      expect(keys).toContain("fs");
      expect(keys).toContain("fs_read");
      expect(keys).toContain("fs_write");
      expect(keys).toContain("fs_delete");
      expect(keys).toContain("runtime");
      expect(keys).toContain("web");
      expect(keys).toContain("browser");
      expect(keys).toContain("db");
      expect(keys).toContain("db_read");
      expect(keys).toContain("db_write");
      expect(keys).toContain("lsp");
      expect(keys).toContain("mcp");
    });
  });
});

describe("isDefaultDeny", () => {
  test("returns true for default-deny decisions from pattern backend", () => {
    const b = createPatternPermissionBackend({
      rules: { allow: ["multiply"], deny: [], ask: [] },
    });
    const d = check(b, "unknown_tool");
    expect(isDefaultDeny(d)).toBe(true);
  });

  test("returns false for explicit deny decisions", () => {
    const b = createPatternPermissionBackend({
      rules: { allow: [], deny: ["bash"], ask: [] },
    });
    const d = check(b, "bash");
    expect(isDefaultDeny(d)).toBe(false);
  });

  test("returns false for allow decisions", () => {
    expect(isDefaultDeny({ effect: "allow" })).toBe(false);
  });

  test("returns false for plain deny without symbol", () => {
    // External backend returns a deny with marker text — should NOT be flagged
    const externalDeny: PermissionDecision = {
      effect: "deny",
      reason: "Blocked (default deny)",
    };
    expect(isDefaultDeny(externalDeny)).toBe(false);
  });
});

describe("createAutoApprovalHandler", () => {
  test("always returns allow", async () => {
    const handler = createAutoApprovalHandler();
    const result = await handler({
      toolId: "bash",
      input: {},
      reason: "test",
    });
    expect(result).toEqual({ kind: "allow" });
  });
});
