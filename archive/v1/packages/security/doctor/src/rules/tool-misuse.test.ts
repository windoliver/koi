/**
 * Unit tests for ASI02 — Tool Misuse rules.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createDoctorContext } from "../context.js";
import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";
import { toolMisuseRules } from "./tool-misuse.js";

const [wildcardAllow, noDenyList, dangerousToolNames] = toolMisuseRules;
if (wildcardAllow === undefined) throw new Error("missing rule: wildcardAllow");
if (noDenyList === undefined) throw new Error("missing rule: noDenyList");
if (dangerousToolNames === undefined) throw new Error("missing rule: dangerousToolNames");

async function check(rule: DoctorRule, ctx: DoctorContext): Promise<readonly DoctorFinding[]> {
  return Promise.resolve(rule.check(ctx));
}

// ---------------------------------------------------------------------------
// tool-misuse:wildcard-allow
// ---------------------------------------------------------------------------

describe("tool-misuse:wildcard-allow", () => {
  test("returns finding when permissions.allow contains wildcard", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { allow: ["*"] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(wildcardAllow, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "tool-misuse:wildcard-allow",
      severity: "CRITICAL",
      category: "TOOL_SAFETY",
      owasp: ["ASI02"],
      path: "permissions.allow",
    });
  });

  test("returns finding when wildcard is among other entries", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { allow: ["read_file", "*", "write_file"] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(wildcardAllow, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns empty when allow list has no wildcard", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { allow: ["read_file", "write_file"] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(wildcardAllow, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when permissions is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(wildcardAllow, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when allow is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { deny: ["exec"] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(wildcardAllow, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(wildcardAllow?.name).toBe("tool-misuse:wildcard-allow");
    expect(wildcardAllow?.category).toBe("TOOL_SAFETY");
    expect(wildcardAllow?.defaultSeverity).toBe("CRITICAL");
    expect(wildcardAllow?.owasp).toEqual(["ASI02"]);
  });
});

// ---------------------------------------------------------------------------
// tool-misuse:no-deny-list
// ---------------------------------------------------------------------------

describe("tool-misuse:no-deny-list", () => {
  test("returns finding when deny list is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { allow: ["read_file"] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noDenyList, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "tool-misuse:no-deny-list",
      severity: "MEDIUM",
      category: "TOOL_SAFETY",
      owasp: ["ASI02"],
      path: "permissions.deny",
    });
  });

  test("returns finding when deny list is empty array", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { deny: [] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noDenyList, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns finding when permissions is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noDenyList, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns empty when deny list has entries", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { deny: ["exec", "shell"] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noDenyList, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noDenyList?.name).toBe("tool-misuse:no-deny-list");
    expect(noDenyList?.category).toBe("TOOL_SAFETY");
    expect(noDenyList?.defaultSeverity).toBe("MEDIUM");
    expect(noDenyList?.owasp).toEqual(["ASI02"]);
  });
});

// ---------------------------------------------------------------------------
// tool-misuse:dangerous-tool-names
// ---------------------------------------------------------------------------

describe("tool-misuse:dangerous-tool-names", () => {
  test("returns finding when dangerous tools are present without sandbox", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "exec" }, { name: "read_file" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(dangerousToolNames, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "tool-misuse:dangerous-tool-names",
      severity: "HIGH",
      category: "TOOL_SAFETY",
      owasp: ["ASI02"],
      path: "tools",
    });
    expect(findings[0]?.message).toContain("exec");
  });

  test("returns finding for shell tool name", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "shell" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(dangerousToolNames, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("shell");
  });

  test("returns finding for eval tool name", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "eval" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(dangerousToolNames, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns finding for run_command tool name", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "run_command" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(dangerousToolNames, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns finding for execute and system tool names", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "execute" }, { name: "system" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(dangerousToolNames, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("execute");
    expect(findings[0]?.message).toContain("system");
  });

  test("returns empty when dangerous tools are present with sandbox middleware", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "exec" }],
      middleware: [{ name: "sandbox" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(dangerousToolNames, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when no dangerous tools are configured", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "read_file" }, { name: "write_file" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(dangerousToolNames, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when no tools are configured", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(dangerousToolNames, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(dangerousToolNames?.name).toBe("tool-misuse:dangerous-tool-names");
    expect(dangerousToolNames?.category).toBe("TOOL_SAFETY");
    expect(dangerousToolNames?.defaultSeverity).toBe("HIGH");
    expect(dangerousToolNames?.owasp).toEqual(["ASI02"]);
  });
});
