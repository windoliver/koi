/**
 * Unit tests for ASI05 — Insecure Code Execution rules.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createDoctorContext } from "../context.js";
import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";
import { codeExecutionRules } from "./code-execution.js";

const [missingSandbox, permissiveForge, noPermissionsMiddleware, noRedactionMiddleware] =
  codeExecutionRules;
if (missingSandbox === undefined) throw new Error("missing rule: missingSandbox");
if (permissiveForge === undefined) throw new Error("missing rule: permissiveForge");
if (noPermissionsMiddleware === undefined) throw new Error("missing rule: noPermissionsMiddleware");
if (noRedactionMiddleware === undefined) throw new Error("missing rule: noRedactionMiddleware");

async function check(rule: DoctorRule, ctx: DoctorContext): Promise<readonly DoctorFinding[]> {
  return Promise.resolve(rule.check(ctx));
}

// ---------------------------------------------------------------------------
// code-execution:missing-sandbox-middleware
// ---------------------------------------------------------------------------

describe("code-execution:missing-sandbox-middleware", () => {
  test("returns finding when tools present but no sandbox middleware", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "read_file" }],
      middleware: [{ name: "audit" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(missingSandbox, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "code-execution:missing-sandbox-middleware",
      severity: "HIGH",
      category: "TOOL_SAFETY",
      owasp: ["ASI05"],
      path: "middleware",
    });
  });

  test("returns finding when tools present and middleware is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "exec" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(missingSandbox, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns empty when sandbox middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "read_file" }],
      middleware: [{ name: "sandbox" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(missingSandbox, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when no tools are configured", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(missingSandbox, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when tools is empty array", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(missingSandbox, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(missingSandbox?.name).toBe("code-execution:missing-sandbox-middleware");
    expect(missingSandbox?.category).toBe("TOOL_SAFETY");
    expect(missingSandbox?.defaultSeverity).toBe("HIGH");
    expect(missingSandbox?.owasp).toEqual(["ASI05"]);
  });
});

// ---------------------------------------------------------------------------
// code-execution:permissive-forge
// ---------------------------------------------------------------------------

describe("code-execution:permissive-forge", () => {
  test("returns finding when forge.preset is permissive", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      metadata: { forge: { preset: "permissive" } },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(permissiveForge, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "code-execution:permissive-forge",
      severity: "HIGH",
      category: "TOOL_SAFETY",
      owasp: ["ASI05"],
      path: "metadata.forge.preset",
    });
  });

  test("returns empty when forge.preset is not permissive", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      metadata: { forge: { preset: "restricted" } },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(permissiveForge, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when metadata is undefined", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(permissiveForge, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when forge is undefined in metadata", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      metadata: { other: "value" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(permissiveForge, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when forge is null in metadata", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      metadata: { forge: null },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(permissiveForge, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(permissiveForge?.name).toBe("code-execution:permissive-forge");
    expect(permissiveForge?.category).toBe("TOOL_SAFETY");
    expect(permissiveForge?.defaultSeverity).toBe("HIGH");
    expect(permissiveForge?.owasp).toEqual(["ASI05"]);
  });
});

// ---------------------------------------------------------------------------
// code-execution:no-permissions-middleware
// ---------------------------------------------------------------------------

describe("code-execution:no-permissions-middleware", () => {
  test("returns finding when tools present but no permissions middleware", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "read_file" }],
      middleware: [{ name: "audit" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noPermissionsMiddleware, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "code-execution:no-permissions-middleware",
      severity: "HIGH",
      category: "TOOL_SAFETY",
      owasp: ["ASI05"],
      path: "middleware",
    });
  });

  test("returns empty when permissions middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "read_file" }],
      middleware: [{ name: "permissions" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noPermissionsMiddleware, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when no tools are configured", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noPermissionsMiddleware, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noPermissionsMiddleware?.name).toBe("code-execution:no-permissions-middleware");
    expect(noPermissionsMiddleware?.category).toBe("TOOL_SAFETY");
    expect(noPermissionsMiddleware?.defaultSeverity).toBe("HIGH");
    expect(noPermissionsMiddleware?.owasp).toEqual(["ASI05"]);
  });
});

// ---------------------------------------------------------------------------
// code-execution:no-redaction-middleware
// ---------------------------------------------------------------------------

describe("code-execution:no-redaction-middleware", () => {
  test("returns finding when tools are configured without redaction middleware", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "read_file" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noRedactionMiddleware, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "code-execution:no-redaction-middleware",
      severity: "MEDIUM",
      category: "TOOL_SAFETY",
      owasp: ["ASI05"],
      path: "middleware",
    });
  });

  test("returns empty when redaction middleware is present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      tools: [{ name: "read_file" }],
      middleware: [{ name: "redaction" }],
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noRedactionMiddleware, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when no tools are configured", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noRedactionMiddleware, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noRedactionMiddleware?.name).toBe("code-execution:no-redaction-middleware");
    expect(noRedactionMiddleware?.category).toBe("TOOL_SAFETY");
    expect(noRedactionMiddleware?.defaultSeverity).toBe("MEDIUM");
    expect(noRedactionMiddleware?.owasp).toEqual(["ASI05"]);
  });
});
