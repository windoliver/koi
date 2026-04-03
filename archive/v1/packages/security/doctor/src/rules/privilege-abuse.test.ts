/**
 * Unit tests for ASI03 — Privilege Escalation / Abuse rules.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createDoctorContext } from "../context.js";
import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";
import { privilegeAbuseRules } from "./privilege-abuse.js";

const [overlyBroadPermissions, noPermissionsConfig, askListEmpty] = privilegeAbuseRules;
if (overlyBroadPermissions === undefined) throw new Error("missing rule: overlyBroadPermissions");
if (noPermissionsConfig === undefined) throw new Error("missing rule: noPermissionsConfig");
if (askListEmpty === undefined) throw new Error("missing rule: askListEmpty");

async function check(rule: DoctorRule, ctx: DoctorContext): Promise<readonly DoctorFinding[]> {
  return Promise.resolve(rule.check(ctx));
}

// ---------------------------------------------------------------------------
// privilege-abuse:overly-broad-permissions
// ---------------------------------------------------------------------------

describe("privilege-abuse:overly-broad-permissions", () => {
  test("returns finding when allow list exceeds threshold of 10", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: {
        allow: Array.from({ length: 11 }, (_, i) => `tool_${String(i)}`),
      },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(overlyBroadPermissions, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "privilege-abuse:overly-broad-permissions",
      severity: "MEDIUM",
      category: "ACCESS_CONTROL",
      owasp: ["ASI03"],
      path: "permissions.allow",
    });
    expect(findings[0]?.message).toContain("11");
  });

  test("returns empty when allow list is at threshold", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: {
        allow: Array.from({ length: 10 }, (_, i) => `tool_${String(i)}`),
      },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(overlyBroadPermissions, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when allow list is below threshold", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { allow: ["read_file", "write_file"] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(overlyBroadPermissions, ctx);

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
    const findings = await check(overlyBroadPermissions, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when permissions is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(overlyBroadPermissions, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(overlyBroadPermissions?.name).toBe("privilege-abuse:overly-broad-permissions");
    expect(overlyBroadPermissions?.category).toBe("ACCESS_CONTROL");
    expect(overlyBroadPermissions?.defaultSeverity).toBe("MEDIUM");
    expect(overlyBroadPermissions?.owasp).toEqual(["ASI03"]);
  });
});

// ---------------------------------------------------------------------------
// privilege-abuse:no-permissions-config
// ---------------------------------------------------------------------------

describe("privilege-abuse:no-permissions-config", () => {
  test("returns finding when permissions is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noPermissionsConfig, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "privilege-abuse:no-permissions-config",
      severity: "HIGH",
      category: "ACCESS_CONTROL",
      owasp: ["ASI03"],
      path: "permissions",
    });
  });

  test("returns empty when permissions is defined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { allow: ["read_file"] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noPermissionsConfig, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when permissions is defined with empty config", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: {},
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noPermissionsConfig, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noPermissionsConfig?.name).toBe("privilege-abuse:no-permissions-config");
    expect(noPermissionsConfig?.category).toBe("ACCESS_CONTROL");
    expect(noPermissionsConfig?.defaultSeverity).toBe("HIGH");
    expect(noPermissionsConfig?.owasp).toEqual(["ASI03"]);
  });
});

// ---------------------------------------------------------------------------
// privilege-abuse:ask-list-empty
// ---------------------------------------------------------------------------

describe("privilege-abuse:ask-list-empty", () => {
  test("returns finding when ask list is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { allow: ["read_file"] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(askListEmpty, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "privilege-abuse:ask-list-empty",
      severity: "LOW",
      category: "ACCESS_CONTROL",
      owasp: ["ASI03"],
      path: "permissions.ask",
    });
  });

  test("returns finding when ask list is empty array", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { ask: [] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(askListEmpty, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns finding when permissions is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(askListEmpty, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns empty when ask list has entries", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { ask: ["write_file", "delete_file"] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(askListEmpty, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(askListEmpty?.name).toBe("privilege-abuse:ask-list-empty");
    expect(askListEmpty?.category).toBe("ACCESS_CONTROL");
    expect(askListEmpty?.defaultSeverity).toBe("LOW");
    expect(askListEmpty?.owasp).toEqual(["ASI03"]);
  });
});
