import { describe, expect, test } from "bun:test";
import type { PermissionDecision } from "@koi/core/permission-backend";
import type { PermissionRules } from "./engine.js";
import {
  createAutoApprovalHandler,
  createPatternPermissionBackend,
  DEFAULT_GROUPS,
} from "./engine.js";

describe("PatternPermissionBackend", () => {
  const backend = createPatternPermissionBackend({
    rules: { allow: [], deny: [], ask: [] },
  });

  async function check(toolId: string, rules: PermissionRules): Promise<PermissionDecision> {
    const b = createPatternPermissionBackend({ rules });
    return b.check({ principal: "agent-1", action: "invoke", resource: toolId });
  }

  test("allows tool matching allow pattern", async () => {
    const result = await check("calc", { allow: ["calc"], deny: [], ask: [] });
    expect(result.effect).toBe("allow");
  });

  test("denies tool matching deny pattern", async () => {
    const result = await check("rm", { allow: [], deny: ["rm"], ask: [] });
    expect(result.effect).toBe("deny");
    if (result.effect === "deny") {
      expect(result.reason).toContain("rm");
    }
  });

  test("deny takes precedence over allow", async () => {
    const result = await check("rm", { allow: ["*"], deny: ["rm"], ask: [] });
    expect(result.effect).toBe("deny");
  });

  test("deny takes precedence over ask", async () => {
    const result = await check("rm", { allow: [], deny: ["rm"], ask: ["rm"] });
    expect(result.effect).toBe("deny");
  });

  test("ask pattern returns 'ask' decision", async () => {
    const result = await check("deploy", { allow: [], deny: [], ask: ["deploy"] });
    expect(result.effect).toBe("ask");
    if (result.effect === "ask") {
      expect(result.reason).toContain("deploy");
    }
  });

  test("ask takes precedence over allow", async () => {
    const result = await check("deploy", { allow: ["*"], deny: [], ask: ["deploy"] });
    expect(result.effect).toBe("ask");
  });

  test("wildcard '*' matches any tool", async () => {
    expect((await check("anything", { allow: ["*"], deny: [], ask: [] })).effect).toBe("allow");
    expect((await check("fs:read", { allow: ["*"], deny: [], ask: [] })).effect).toBe("allow");
  });

  test("prefix wildcard matches tools with that prefix", async () => {
    expect((await check("fs:read", { allow: ["fs:*"], deny: [], ask: [] })).effect).toBe("allow");
    expect((await check("fs:write", { allow: ["fs:*"], deny: [], ask: [] })).effect).toBe("allow");
    expect((await check("db:query", { allow: ["fs:*"], deny: [], ask: [] })).effect).toBe("deny");
  });

  test("exact match only matches exact tool ID", async () => {
    expect((await check("calc", { allow: ["calc"], deny: [], ask: [] })).effect).toBe("allow");
    expect((await check("calculator", { allow: ["calc"], deny: [], ask: [] })).effect).toBe("deny");
  });

  test("defaultDeny blocks unmatched tools", async () => {
    const result = await check("unknown-tool", { allow: [], deny: [], ask: [] });
    expect(result.effect).toBe("deny");
    if (result.effect === "deny") {
      expect(result.reason).toContain("default deny");
    }
  });

  test("defaultDeny=false allows unmatched tools", async () => {
    const permissive = createPatternPermissionBackend({
      rules: { allow: [], deny: [], ask: [] },
      defaultDeny: false,
    });
    const result = await permissive.check({
      principal: "agent-1",
      action: "invoke",
      resource: "unknown-tool",
    });
    expect(result.effect).toBe("allow");
  });

  test("multiple allow patterns work", async () => {
    const rules: PermissionRules = { allow: ["calc", "search", "fs:*"], deny: [], ask: [] };
    expect((await check("calc", rules)).effect).toBe("allow");
    expect((await check("search", rules)).effect).toBe("allow");
    expect((await check("fs:read", rules)).effect).toBe("allow");
    expect((await check("db:query", rules)).effect).toBe("deny");
  });

  test("multiple deny patterns work", async () => {
    const rules: PermissionRules = { allow: ["*"], deny: ["rm", "sudo:*"], ask: [] };
    expect((await check("rm", rules)).effect).toBe("deny");
    expect((await check("sudo:reboot", rules)).effect).toBe("deny");
    expect((await check("calc", rules)).effect).toBe("allow");
  });

  test("check returns synchronously", async () => {
    const result = await backend.check({ principal: "a", action: "invoke", resource: "x" });
    // Should be a plain object, not a Promise
    expect(typeof result).toBe("object");
    expect("effect" in result).toBe(true);
  });
});

describe("Named tool groups", () => {
  const groups = {
    fs: ["fs:read", "fs:write", "fs:stat"],
    net: ["http:get", "http:post"],
  } as const;

  async function checkWithGroups(
    toolId: string,
    rules: PermissionRules,
  ): Promise<PermissionDecision> {
    const b = createPatternPermissionBackend({ rules, groups });
    return b.check({ principal: "agent-1", action: "invoke", resource: toolId });
  }

  test("expands group in allow list", async () => {
    const result = await checkWithGroups("fs:read", { allow: ["group:fs"], deny: [], ask: [] });
    expect(result.effect).toBe("allow");
  });

  test("expands group in deny list", async () => {
    const result = await checkWithGroups("http:get", {
      allow: ["*"],
      deny: ["group:net"],
      ask: [],
    });
    expect(result.effect).toBe("deny");
  });

  test("expands group in ask list", async () => {
    const result = await checkWithGroups("fs:write", { allow: ["*"], deny: [], ask: ["group:fs"] });
    expect(result.effect).toBe("ask");
  });

  test("unknown group preserved as literal pattern", async () => {
    const result = await checkWithGroups("group:unknown", {
      allow: ["group:unknown"],
      deny: [],
      ask: [],
    });
    expect(result.effect).toBe("allow");
  });

  test("mixed groups and plain patterns", async () => {
    const result = await checkWithGroups("calc", {
      allow: ["group:fs", "calc"],
      deny: [],
      ask: [],
    });
    expect(result.effect).toBe("allow");
  });

  test("works without groups config (backward compat)", async () => {
    const b = createPatternPermissionBackend({
      rules: { allow: ["calc"], deny: [], ask: [] },
    });
    expect((await b.check({ principal: "a", action: "invoke", resource: "calc" })).effect).toBe(
      "allow",
    );
  });
});

describe("DEFAULT_GROUPS", () => {
  async function checkWithDefaults(
    toolId: string,
    rules: PermissionRules,
  ): Promise<PermissionDecision> {
    const b = createPatternPermissionBackend({ rules, groups: DEFAULT_GROUPS });
    return b.check({ principal: "agent-1", action: "invoke", resource: toolId });
  }

  test("group:fs matches filesystem tools via prefix wildcard", async () => {
    expect(
      (await checkWithDefaults("fs:read", { allow: ["group:fs"], deny: [], ask: [] })).effect,
    ).toBe("allow");
    expect(
      (await checkWithDefaults("fs:write", { allow: ["group:fs"], deny: [], ask: [] })).effect,
    ).toBe("allow");
    expect(
      (await checkWithDefaults("fs:delete", { allow: ["group:fs"], deny: [], ask: [] })).effect,
    ).toBe("allow");
  });

  test("group:fs_read allows read-only fs tools but not write", async () => {
    const rules: PermissionRules = { allow: ["group:fs_read"], deny: [], ask: [] };
    expect((await checkWithDefaults("fs:read", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("fs:stat", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("fs:write", rules)).effect).toBe("deny");
  });

  test("group:runtime matches shell execution tools", async () => {
    const rules: PermissionRules = { allow: ["group:runtime"], deny: [], ask: [] };
    expect((await checkWithDefaults("exec", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("bash", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("spawn", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("fs:read", rules)).effect).toBe("deny");
  });

  test("group:web matches HTTP tools via prefix wildcard", async () => {
    const rules: PermissionRules = { allow: ["group:web"], deny: [], ask: [] };
    expect((await checkWithDefaults("http:get", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("http:post", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("fetch", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("curl", rules)).effect).toBe("allow");
  });

  test("group:browser matches browser automation tools", async () => {
    const rules: PermissionRules = { allow: ["group:browser"], deny: [], ask: [] };
    expect((await checkWithDefaults("browser_navigate", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("browser_click", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("browser_screenshot", rules)).effect).toBe("allow");
  });

  test("group:db matches all database tools via prefix wildcard", async () => {
    const rules: PermissionRules = { allow: ["group:db"], deny: [], ask: [] };
    expect((await checkWithDefaults("db:query", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("db:insert", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("db:delete", rules)).effect).toBe("allow");
  });

  test("group:lsp and group:mcp match namespaced tools", async () => {
    const rules: PermissionRules = { allow: ["group:lsp", "group:mcp"], deny: [], ask: [] };
    expect((await checkWithDefaults("lsp/ts/hover", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("mcp/filesystem/read", rules)).effect).toBe("allow");
  });

  test("deny group:runtime while allowing group:fs_read", async () => {
    const rules: PermissionRules = {
      allow: ["group:fs_read"],
      deny: ["group:runtime"],
      ask: [],
    };
    expect((await checkWithDefaults("fs:read", rules)).effect).toBe("allow");
    expect((await checkWithDefaults("exec", rules)).effect).toBe("deny");
    expect((await checkWithDefaults("bash", rules)).effect).toBe("deny");
  });

  test("user groups can extend DEFAULT_GROUPS", async () => {
    const merged = { ...DEFAULT_GROUPS, custom: ["my_tool_a", "my_tool_b"] };
    const b = createPatternPermissionBackend({
      rules: { allow: ["group:custom", "group:fs_read"], deny: [], ask: [] },
      groups: merged,
    });
    expect(
      (await b.check({ principal: "a", action: "invoke", resource: "my_tool_a" })).effect,
    ).toBe("allow");
    expect((await b.check({ principal: "a", action: "invoke", resource: "fs:read" })).effect).toBe(
      "allow",
    );
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
