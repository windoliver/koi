/**
 * Unit tests for ASI07 — Insecure Agent Delegation rules.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createDoctorContext } from "../context.js";
import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";
import { insecureDelegationRules } from "./insecure-delegation.js";

const [unsignedGrants, excessiveChainDepth, longTtl] = insecureDelegationRules;
if (unsignedGrants === undefined) throw new Error("missing rule: unsignedGrants");
if (excessiveChainDepth === undefined) throw new Error("missing rule: excessiveChainDepth");
if (longTtl === undefined) throw new Error("missing rule: longTtl");

async function check(rule: DoctorRule, ctx: DoctorContext): Promise<readonly DoctorFinding[]> {
  return Promise.resolve(rule.check(ctx));
}

// ---------------------------------------------------------------------------
// insecure-delegation:unsigned-grants
// ---------------------------------------------------------------------------

describe("insecure-delegation:unsigned-grants", () => {
  test("returns finding when delegation enabled but DELEGATION_SECRET missing", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest, { envKeys: new Set([]) });
    const findings = await check(unsignedGrants, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "insecure-delegation:unsigned-grants",
      severity: "CRITICAL",
      category: "ACCESS_CONTROL",
      owasp: ["ASI07"],
      path: "delegation",
    });
  });

  test("returns empty when delegation enabled and DELEGATION_SECRET is set", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest, { envKeys: new Set(["DELEGATION_SECRET"]) });
    const findings = await check(unsignedGrants, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when delegation is disabled", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: false, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest, { envKeys: new Set([]) });
    const findings = await check(unsignedGrants, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when delegation is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest, { envKeys: new Set([]) });
    const findings = await check(unsignedGrants, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(unsignedGrants?.name).toBe("insecure-delegation:unsigned-grants");
    expect(unsignedGrants?.category).toBe("ACCESS_CONTROL");
    expect(unsignedGrants?.defaultSeverity).toBe("CRITICAL");
    expect(unsignedGrants?.owasp).toEqual(["ASI07"]);
  });
});

// ---------------------------------------------------------------------------
// insecure-delegation:excessive-chain-depth
// ---------------------------------------------------------------------------

describe("insecure-delegation:excessive-chain-depth", () => {
  test("returns finding when maxChainDepth exceeds safe threshold of 5", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 10, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(excessiveChainDepth, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "insecure-delegation:excessive-chain-depth",
      severity: "MEDIUM",
      category: "ACCESS_CONTROL",
      owasp: ["ASI07"],
      path: "delegation.maxChainDepth",
    });
    expect(findings[0]?.message).toContain("10");
  });

  test("returns finding when maxChainDepth is 6", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 6, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(excessiveChainDepth, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns empty when maxChainDepth is at safe threshold", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 5, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(excessiveChainDepth, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when maxChainDepth is below threshold", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(excessiveChainDepth, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when delegation is disabled", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: false, maxChainDepth: 100, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(excessiveChainDepth, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when delegation is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(excessiveChainDepth, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(excessiveChainDepth?.name).toBe("insecure-delegation:excessive-chain-depth");
    expect(excessiveChainDepth?.category).toBe("ACCESS_CONTROL");
    expect(excessiveChainDepth?.defaultSeverity).toBe("MEDIUM");
    expect(excessiveChainDepth?.owasp).toEqual(["ASI07"]);
  });
});

// ---------------------------------------------------------------------------
// insecure-delegation:long-ttl
// ---------------------------------------------------------------------------

describe("insecure-delegation:long-ttl", () => {
  test("returns finding when defaultTtlMs exceeds 24 hours", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 172_800_000 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(longTtl, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "insecure-delegation:long-ttl",
      severity: "MEDIUM",
      category: "ACCESS_CONTROL",
      owasp: ["ASI07"],
      path: "delegation.defaultTtlMs",
    });
    expect(findings[0]?.message).toContain("172800000");
  });

  test("returns empty when defaultTtlMs is exactly 24 hours", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 86_400_000 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(longTtl, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when defaultTtlMs is below 24 hours", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(longTtl, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when delegation is disabled", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: false, maxChainDepth: 3, defaultTtlMs: 999_999_999 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(longTtl, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when delegation is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(longTtl, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(longTtl?.name).toBe("insecure-delegation:long-ttl");
    expect(longTtl?.category).toBe("ACCESS_CONTROL");
    expect(longTtl?.defaultSeverity).toBe("MEDIUM");
    expect(longTtl?.owasp).toEqual(["ASI07"]);
  });
});
