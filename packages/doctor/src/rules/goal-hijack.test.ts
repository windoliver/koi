/**
 * Unit tests for ASI01 — Agentic Goal Hijacking rules.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createDoctorContext } from "../context.js";
import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";
import { goalHijackRules } from "./goal-hijack.js";

const [missingSanitize, missingGuardrails, noSystemPromptDefense] = goalHijackRules;
if (missingSanitize === undefined) throw new Error("missing rule: missingSanitize");
if (missingGuardrails === undefined) throw new Error("missing rule: missingGuardrails");
if (noSystemPromptDefense === undefined) throw new Error("missing rule: noSystemPromptDefense");

async function check(rule: DoctorRule, ctx: DoctorContext): Promise<readonly DoctorFinding[]> {
  return Promise.resolve(rule.check(ctx));
}

// ---------------------------------------------------------------------------
// goal-hijack:missing-sanitize-middleware
// ---------------------------------------------------------------------------

describe("goal-hijack:missing-sanitize-middleware", () => {
  test("returns finding when sanitize middleware is absent", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "audit" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(missingSanitize, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "goal-hijack:missing-sanitize-middleware",
      severity: "HIGH",
      category: "GOAL_INTEGRITY",
      owasp: ["ASI01"],
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
    const findings = await check(missingSanitize, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("goal-hijack:missing-sanitize-middleware");
  });

  test("returns empty when sanitize middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "sanitize" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(missingSanitize, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(missingSanitize?.name).toBe("goal-hijack:missing-sanitize-middleware");
    expect(missingSanitize?.category).toBe("GOAL_INTEGRITY");
    expect(missingSanitize?.defaultSeverity).toBe("HIGH");
    expect(missingSanitize?.owasp).toEqual(["ASI01"]);
  });
});

// ---------------------------------------------------------------------------
// goal-hijack:missing-guardrails-middleware
// ---------------------------------------------------------------------------

describe("goal-hijack:missing-guardrails-middleware", () => {
  test("returns finding when guardrails middleware is absent", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "sanitize" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(missingGuardrails, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "goal-hijack:missing-guardrails-middleware",
      severity: "MEDIUM",
      category: "GOAL_INTEGRITY",
      owasp: ["ASI01"],
      path: "middleware",
    });
  });

  test("returns empty when guardrails middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "guardrails" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(missingGuardrails, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(missingGuardrails?.name).toBe("goal-hijack:missing-guardrails-middleware");
    expect(missingGuardrails?.category).toBe("GOAL_INTEGRITY");
    expect(missingGuardrails?.defaultSeverity).toBe("MEDIUM");
    expect(missingGuardrails?.owasp).toEqual(["ASI01"]);
  });
});

// ---------------------------------------------------------------------------
// goal-hijack:no-system-prompt-defense
// ---------------------------------------------------------------------------

describe("goal-hijack:no-system-prompt-defense", () => {
  test("returns finding when model.options is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noSystemPromptDefense, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "goal-hijack:no-system-prompt-defense",
      severity: "MEDIUM",
      category: "GOAL_INTEGRITY",
      owasp: ["ASI01"],
      path: "model.options",
    });
  });

  test("returns empty when model.options is defined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet", options: { systemPromptDefense: true } },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noSystemPromptDefense, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when model.options is an empty object", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet", options: {} },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noSystemPromptDefense, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noSystemPromptDefense?.name).toBe("goal-hijack:no-system-prompt-defense");
    expect(noSystemPromptDefense?.category).toBe("GOAL_INTEGRITY");
    expect(noSystemPromptDefense?.defaultSeverity).toBe("MEDIUM");
    expect(noSystemPromptDefense?.owasp).toEqual(["ASI01"]);
  });
});
