/**
 * Unit tests for ASI08 — Cascading Failures & Denial of Service rules.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createDoctorContext } from "../context.js";
import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";
import { cascadingFailuresRules } from "./cascading-failures.js";

const [noCallLimits, noCircuitBreaker, noBudgetLimits] = cascadingFailuresRules;
if (noCallLimits === undefined) throw new Error("missing rule: noCallLimits");
if (noCircuitBreaker === undefined) throw new Error("missing rule: noCircuitBreaker");
if (noBudgetLimits === undefined) throw new Error("missing rule: noBudgetLimits");

async function check(rule: DoctorRule, ctx: DoctorContext): Promise<readonly DoctorFinding[]> {
  return Promise.resolve(rule.check(ctx));
}

// ---------------------------------------------------------------------------
// cascading-failures:no-call-limits
// ---------------------------------------------------------------------------

describe("cascading-failures:no-call-limits", () => {
  test("returns finding when call-limits middleware is absent", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "audit" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noCallLimits, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "cascading-failures:no-call-limits",
      severity: "HIGH",
      category: "RESILIENCE",
      owasp: ["ASI08"],
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
    const findings = await check(noCallLimits, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns empty when call-limits middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "call-limits" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noCallLimits, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when call-limits is among other middleware", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "audit" }, { name: "call-limits" }, { name: "sandbox" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noCallLimits, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noCallLimits?.name).toBe("cascading-failures:no-call-limits");
    expect(noCallLimits?.category).toBe("RESILIENCE");
    expect(noCallLimits?.defaultSeverity).toBe("HIGH");
    expect(noCallLimits?.owasp).toEqual(["ASI08"]);
  });
});

// ---------------------------------------------------------------------------
// cascading-failures:no-circuit-breaker
// ---------------------------------------------------------------------------

describe("cascading-failures:no-circuit-breaker", () => {
  test("returns finding when delegation enabled and no circuit breaker configured", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noCircuitBreaker, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "cascading-failures:no-circuit-breaker",
      severity: "MEDIUM",
      category: "RESILIENCE",
      owasp: ["ASI08"],
      path: "delegation",
    });
  });

  test("returns finding when delegation enabled with middleware but no circuit-breaker", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      middleware: [{ name: "audit" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noCircuitBreaker, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns empty when circuit-breaker middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      middleware: [{ name: "circuit-breaker" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noCircuitBreaker, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when circuitBreaker metadata is configured", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      metadata: { circuitBreaker: { failureThreshold: 5 } },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noCircuitBreaker, ctx);

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
    const findings = await check(noCircuitBreaker, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when delegation is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noCircuitBreaker, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noCircuitBreaker?.name).toBe("cascading-failures:no-circuit-breaker");
    expect(noCircuitBreaker?.category).toBe("RESILIENCE");
    expect(noCircuitBreaker?.defaultSeverity).toBe("MEDIUM");
    expect(noCircuitBreaker?.owasp).toEqual(["ASI08"]);
  });
});

// ---------------------------------------------------------------------------
// cascading-failures:no-budget-limits
// ---------------------------------------------------------------------------

describe("cascading-failures:no-budget-limits", () => {
  test("returns finding when no budget middleware or maxCostUsd configured", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noBudgetLimits, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "cascading-failures:no-budget-limits",
      severity: "MEDIUM",
      category: "RESILIENCE",
      owasp: ["ASI08"],
      path: "middleware",
    });
  });

  test("returns empty when budget middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "budget" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noBudgetLimits, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when pay middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "pay" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noBudgetLimits, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when maxCostUsd is set in metadata", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      metadata: { maxCostUsd: 5.0 },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noBudgetLimits, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noBudgetLimits?.name).toBe("cascading-failures:no-budget-limits");
    expect(noBudgetLimits?.category).toBe("RESILIENCE");
    expect(noBudgetLimits?.defaultSeverity).toBe("MEDIUM");
    expect(noBudgetLimits?.owasp).toEqual(["ASI08"]);
  });
});
