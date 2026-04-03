/**
 * Unit tests for ASI09 — Overreliance on Agentic Systems / Human Trust rules.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createDoctorContext } from "../context.js";
import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";
import { humanTrustRules } from "./human-trust.js";

const [noHitlConfig, noAuditTrail] = humanTrustRules;
if (noHitlConfig === undefined) throw new Error("missing rule: noHitlConfig");
if (noAuditTrail === undefined) throw new Error("missing rule: noAuditTrail");

async function check(rule: DoctorRule, ctx: DoctorContext): Promise<readonly DoctorFinding[]> {
  return Promise.resolve(rule.check(ctx));
}

// ---------------------------------------------------------------------------
// human-trust:no-hitl-config
// ---------------------------------------------------------------------------

describe("human-trust:no-hitl-config", () => {
  test("returns finding when no turn-ack middleware and no ask list", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "audit" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noHitlConfig, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "human-trust:no-hitl-config",
      severity: "MEDIUM",
      category: "RESILIENCE",
      owasp: ["ASI09"],
      path: "middleware",
    });
  });

  test("returns finding when middleware is undefined and no ask list", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noHitlConfig, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns finding when ask list is empty array", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { ask: [] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noHitlConfig, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns empty when turn-ack middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "turn-ack" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noHitlConfig, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when ask list has entries", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      permissions: { ask: ["write_file"] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noHitlConfig, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when both turn-ack and ask list are configured", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "turn-ack" }],
      permissions: { ask: ["write_file"] },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noHitlConfig, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noHitlConfig?.name).toBe("human-trust:no-hitl-config");
    expect(noHitlConfig?.category).toBe("RESILIENCE");
    expect(noHitlConfig?.defaultSeverity).toBe("MEDIUM");
    expect(noHitlConfig?.owasp).toEqual(["ASI09"]);
  });
});

// ---------------------------------------------------------------------------
// human-trust:no-audit-trail
// ---------------------------------------------------------------------------

describe("human-trust:no-audit-trail", () => {
  test("returns finding when audit middleware is absent", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "sanitize" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noAuditTrail, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "human-trust:no-audit-trail",
      severity: "MEDIUM",
      category: "RESILIENCE",
      owasp: ["ASI09"],
      path: "middleware",
    });
  });

  test("returns finding when middleware is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noAuditTrail, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns empty when audit middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "audit" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noAuditTrail, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when audit is among other middleware", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "sanitize" }, { name: "audit" }, { name: "sandbox" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noAuditTrail, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noAuditTrail?.name).toBe("human-trust:no-audit-trail");
    expect(noAuditTrail?.category).toBe("RESILIENCE");
    expect(noAuditTrail?.defaultSeverity).toBe("MEDIUM");
    expect(noAuditTrail?.owasp).toEqual(["ASI09"]);
  });
});
