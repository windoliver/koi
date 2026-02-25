/**
 * Unit tests for ASI06 — Memory Poisoning rules.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createDoctorContext } from "../context.js";
import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";
import { memoryPoisoningRules } from "./memory-poisoning.js";

const [memoryWithoutSanitize, noContextLimits] = memoryPoisoningRules;
if (memoryWithoutSanitize === undefined) throw new Error("missing rule: memoryWithoutSanitize");
if (noContextLimits === undefined) throw new Error("missing rule: noContextLimits");

async function check(rule: DoctorRule, ctx: DoctorContext): Promise<readonly DoctorFinding[]> {
  return Promise.resolve(rule.check(ctx));
}

// ---------------------------------------------------------------------------
// memory-poisoning:memory-without-sanitize
// ---------------------------------------------------------------------------

describe("memory-poisoning:memory-without-sanitize", () => {
  test("returns finding when memory middleware present without sanitize", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "memory" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(memoryWithoutSanitize, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "memory-poisoning:memory-without-sanitize",
      severity: "HIGH",
      category: "RESILIENCE",
      owasp: ["ASI06"],
      path: "middleware",
    });
  });

  test("returns finding when memory present with other middleware but no sanitize", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "memory" }, { name: "audit" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(memoryWithoutSanitize, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns empty when both memory and sanitize are present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "sanitize" }, { name: "memory" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(memoryWithoutSanitize, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when memory middleware is not present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "audit" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(memoryWithoutSanitize, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when middleware is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(memoryWithoutSanitize, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(memoryWithoutSanitize?.name).toBe("memory-poisoning:memory-without-sanitize");
    expect(memoryWithoutSanitize?.category).toBe("RESILIENCE");
    expect(memoryWithoutSanitize?.defaultSeverity).toBe("HIGH");
    expect(memoryWithoutSanitize?.owasp).toEqual(["ASI06"]);
  });
});

// ---------------------------------------------------------------------------
// memory-poisoning:no-context-limits
// ---------------------------------------------------------------------------

describe("memory-poisoning:no-context-limits", () => {
  test("returns finding when neither compactor nor context-editing middleware present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "audit" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noContextLimits, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "memory-poisoning:no-context-limits",
      severity: "MEDIUM",
      category: "RESILIENCE",
      owasp: ["ASI06"],
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
    const findings = await check(noContextLimits, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns empty when compactor middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "compactor" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noContextLimits, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when context-editing middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "context-editing" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noContextLimits, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when both compactor and context-editing are present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      middleware: [{ name: "compactor" }, { name: "context-editing" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noContextLimits, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noContextLimits?.name).toBe("memory-poisoning:no-context-limits");
    expect(noContextLimits?.category).toBe("RESILIENCE");
    expect(noContextLimits?.defaultSeverity).toBe("MEDIUM");
    expect(noContextLimits?.owasp).toEqual(["ASI06"]);
  });
});
