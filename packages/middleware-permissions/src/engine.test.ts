import { describe, expect, test } from "bun:test";
import type { PermissionRules } from "./engine.js";
import { createAutoApprovalHandler, createPatternPermissionEngine } from "./engine.js";

describe("PatternPermissionEngine", () => {
  const engine = createPatternPermissionEngine();

  test("allows tool matching allow pattern", () => {
    const rules: PermissionRules = { allow: ["calc"], deny: [], ask: [] };
    const result = engine.check("calc", {}, rules);
    expect(result.allowed).toBe(true);
  });

  test("denies tool matching deny pattern", () => {
    const rules: PermissionRules = { allow: [], deny: ["rm"], ask: [] };
    const result = engine.check("rm", {}, rules);
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("rm");
    }
  });

  test("deny takes precedence over allow", () => {
    const rules: PermissionRules = { allow: ["*"], deny: ["rm"], ask: [] };
    const result = engine.check("rm", {}, rules);
    expect(result.allowed).toBe(false);
  });

  test("deny takes precedence over ask", () => {
    const rules: PermissionRules = { allow: [], deny: ["rm"], ask: ["rm"] };
    const result = engine.check("rm", {}, rules);
    expect(result.allowed).toBe(false);
  });

  test("ask pattern returns 'ask' decision", () => {
    const rules: PermissionRules = { allow: [], deny: [], ask: ["deploy"] };
    const result = engine.check("deploy", {}, rules);
    expect(result.allowed).toBe("ask");
    if (result.allowed === "ask") {
      expect(result.reason).toContain("deploy");
    }
  });

  test("ask takes precedence over allow", () => {
    const rules: PermissionRules = { allow: ["*"], deny: [], ask: ["deploy"] };
    const result = engine.check("deploy", {}, rules);
    expect(result.allowed).toBe("ask");
  });

  test("wildcard '*' matches any tool", () => {
    const rules: PermissionRules = { allow: ["*"], deny: [], ask: [] };
    expect(engine.check("anything", {}, rules).allowed).toBe(true);
    expect(engine.check("fs:read", {}, rules).allowed).toBe(true);
  });

  test("prefix wildcard matches tools with that prefix", () => {
    const rules: PermissionRules = { allow: ["fs:*"], deny: [], ask: [] };
    expect(engine.check("fs:read", {}, rules).allowed).toBe(true);
    expect(engine.check("fs:write", {}, rules).allowed).toBe(true);
    expect(engine.check("db:query", {}, rules).allowed).toBe(false);
  });

  test("exact match only matches exact tool ID", () => {
    const rules: PermissionRules = { allow: ["calc"], deny: [], ask: [] };
    expect(engine.check("calc", {}, rules).allowed).toBe(true);
    expect(engine.check("calculator", {}, rules).allowed).toBe(false);
  });

  test("defaultDeny blocks unmatched tools", () => {
    const rules: PermissionRules = { allow: [], deny: [], ask: [] };
    const result = engine.check("unknown-tool", {}, rules);
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("default deny");
    }
  });

  test("defaultDeny=false allows unmatched tools", () => {
    const permissiveEngine = createPatternPermissionEngine(false);
    const rules: PermissionRules = { allow: [], deny: [], ask: [] };
    const result = permissiveEngine.check("unknown-tool", {}, rules);
    expect(result.allowed).toBe(true);
  });

  test("multiple allow patterns work", () => {
    const rules: PermissionRules = { allow: ["calc", "search", "fs:*"], deny: [], ask: [] };
    expect(engine.check("calc", {}, rules).allowed).toBe(true);
    expect(engine.check("search", {}, rules).allowed).toBe(true);
    expect(engine.check("fs:read", {}, rules).allowed).toBe(true);
    expect(engine.check("db:query", {}, rules).allowed).toBe(false);
  });

  test("multiple deny patterns work", () => {
    const rules: PermissionRules = { allow: ["*"], deny: ["rm", "sudo:*"], ask: [] };
    expect(engine.check("rm", {}, rules).allowed).toBe(false);
    expect(engine.check("sudo:reboot", {}, rules).allowed).toBe(false);
    expect(engine.check("calc", {}, rules).allowed).toBe(true);
  });
});

describe("AutoApprovalHandler", () => {
  test("always approves", async () => {
    const handler = createAutoApprovalHandler();
    const result = await handler.requestApproval("tool", {}, "reason");
    expect(result).toBe(true);
  });

  test("approves any tool ID", async () => {
    const handler = createAutoApprovalHandler();
    expect(await handler.requestApproval("dangerous-tool", {}, "test")).toBe(true);
    expect(await handler.requestApproval("rm", { path: "/" }, "deletes everything")).toBe(true);
  });
});
