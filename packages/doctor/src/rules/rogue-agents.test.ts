/**
 * Unit tests for ASI10 — Rogue Agent / Uncontrolled Autonomy rules.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createDoctorContext } from "../context.js";
import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";
import { rogueAgentsRules } from "./rogue-agents.js";

const [noGovernance, noAgentMonitor] = rogueAgentsRules;
if (noGovernance === undefined) throw new Error("missing rule: noGovernance");
if (noAgentMonitor === undefined) throw new Error("missing rule: noAgentMonitor");

async function check(rule: DoctorRule, ctx: DoctorContext): Promise<readonly DoctorFinding[]> {
  return Promise.resolve(rule.check(ctx));
}

// ---------------------------------------------------------------------------
// rogue-agents:no-governance
// ---------------------------------------------------------------------------

describe("rogue-agents:no-governance", () => {
  test("returns finding when delegation enabled but no governance middleware", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noGovernance, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "rogue-agents:no-governance",
      severity: "HIGH",
      category: "RESILIENCE",
      owasp: ["ASI10"],
      path: "middleware",
    });
  });

  test("returns finding when delegation enabled with other middleware but no governance", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      middleware: [{ name: "audit" }, { name: "sandbox" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noGovernance, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns empty when governance middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      middleware: [{ name: "governance" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noGovernance, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when delegation is disabled", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: false, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noGovernance, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when delegation is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noGovernance, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when delegation is undefined and governance is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "governance" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noGovernance, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noGovernance?.name).toBe("rogue-agents:no-governance");
    expect(noGovernance?.category).toBe("RESILIENCE");
    expect(noGovernance?.defaultSeverity).toBe("HIGH");
    expect(noGovernance?.owasp).toEqual(["ASI10"]);
  });
});

// ---------------------------------------------------------------------------
// rogue-agents:no-agent-monitor
// ---------------------------------------------------------------------------

describe("rogue-agents:no-agent-monitor", () => {
  test("returns finding when delegation enabled but no monitoring middleware", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noAgentMonitor, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "rogue-agents:no-agent-monitor",
      severity: "MEDIUM",
      category: "RESILIENCE",
      owasp: ["ASI10"],
      path: "middleware",
    });
  });

  test("returns empty when agent-monitor middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      middleware: [{ name: "agent-monitor" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noAgentMonitor, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when monitor middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      middleware: [{ name: "monitor" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noAgentMonitor, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when delegation is disabled", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: false, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noAgentMonitor, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when delegation is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noAgentMonitor, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noAgentMonitor?.name).toBe("rogue-agents:no-agent-monitor");
    expect(noAgentMonitor?.category).toBe("RESILIENCE");
    expect(noAgentMonitor?.defaultSeverity).toBe("MEDIUM");
    expect(noAgentMonitor?.owasp).toEqual(["ASI10"]);
  });
});
