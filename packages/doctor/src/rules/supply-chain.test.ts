/**
 * Unit tests for ASI04 — Supply Chain Vulnerability rules.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createDoctorContext } from "../context.js";
import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";
import { supplyChainRules } from "./supply-chain.js";

const [
  noDependenciesProvided,
  excessiveDependencies,
  knownVulnerablePatterns,
  forgeVerificationDisabled,
] = supplyChainRules;
if (noDependenciesProvided === undefined) throw new Error("missing rule: noDependenciesProvided");
if (excessiveDependencies === undefined) throw new Error("missing rule: excessiveDependencies");
if (knownVulnerablePatterns === undefined) throw new Error("missing rule: knownVulnerablePatterns");
if (forgeVerificationDisabled === undefined)
  throw new Error("missing rule: forgeVerificationDisabled");

async function check(rule: DoctorRule, ctx: DoctorContext): Promise<readonly DoctorFinding[]> {
  return Promise.resolve(rule.check(ctx));
}

// ---------------------------------------------------------------------------
// supply-chain:no-dependencies-provided
// ---------------------------------------------------------------------------

describe("supply-chain:no-dependencies-provided", () => {
  test("returns finding when no dependencies and no packageJson provided", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(noDependenciesProvided, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "supply-chain:no-dependencies-provided",
      severity: "LOW",
      category: "SUPPLY_CHAIN",
      owasp: ["ASI04"],
    });
  });

  test("returns empty when dependencies are provided", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest, {
      dependencies: [{ name: "zod", version: "3.0.0", isDev: false }],
    });
    const findings = await check(noDependenciesProvided, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when packageJson is provided", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest, {
      packageJson: { name: "test", dependencies: { zod: "3.0.0" } },
    });
    const findings = await check(noDependenciesProvided, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(noDependenciesProvided?.name).toBe("supply-chain:no-dependencies-provided");
    expect(noDependenciesProvided?.category).toBe("SUPPLY_CHAIN");
    expect(noDependenciesProvided?.defaultSeverity).toBe("LOW");
    expect(noDependenciesProvided?.owasp).toEqual(["ASI04"]);
  });
});

// ---------------------------------------------------------------------------
// supply-chain:excessive-dependencies
// ---------------------------------------------------------------------------

describe("supply-chain:excessive-dependencies", () => {
  test("returns finding when production deps exceed threshold of 50", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const deps = Array.from({ length: 51 }, (_, i) => ({
      name: `dep-${String(i)}`,
      version: "1.0.0",
      isDev: false,
    }));
    const ctx = createDoctorContext(manifest, { dependencies: deps });
    const findings = await check(excessiveDependencies, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "supply-chain:excessive-dependencies",
      severity: "MEDIUM",
      category: "SUPPLY_CHAIN",
      owasp: ["ASI04"],
    });
    expect(findings[0]?.message).toContain("51");
  });

  test("returns empty when production deps are at threshold", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const deps = Array.from({ length: 50 }, (_, i) => ({
      name: `dep-${String(i)}`,
      version: "1.0.0",
      isDev: false,
    }));
    const ctx = createDoctorContext(manifest, { dependencies: deps });
    const findings = await check(excessiveDependencies, ctx);

    expect(findings).toHaveLength(0);
  });

  test("counts only production deps, not dev deps", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const prodDeps = Array.from({ length: 10 }, (_, i) => ({
      name: `prod-${String(i)}`,
      version: "1.0.0",
      isDev: false,
    }));
    const devDeps = Array.from({ length: 100 }, (_, i) => ({
      name: `dev-${String(i)}`,
      version: "1.0.0",
      isDev: true,
    }));
    const ctx = createDoctorContext(manifest, { dependencies: [...prodDeps, ...devDeps] });
    const findings = await check(excessiveDependencies, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when no dependencies provided", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(excessiveDependencies, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(excessiveDependencies?.name).toBe("supply-chain:excessive-dependencies");
    expect(excessiveDependencies?.category).toBe("SUPPLY_CHAIN");
    expect(excessiveDependencies?.defaultSeverity).toBe("MEDIUM");
    expect(excessiveDependencies?.owasp).toEqual(["ASI04"]);
  });
});

// ---------------------------------------------------------------------------
// supply-chain:known-vulnerable-patterns
// ---------------------------------------------------------------------------

describe("supply-chain:known-vulnerable-patterns", () => {
  test("returns finding when event-stream is in dependencies", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest, {
      dependencies: [{ name: "event-stream", version: "3.3.4", isDev: false }],
    });
    const findings = await check(knownVulnerablePatterns, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "supply-chain:known-vulnerable-patterns",
      severity: "HIGH",
      category: "SUPPLY_CHAIN",
      owasp: ["ASI04"],
    });
    expect(findings[0]?.message).toContain("event-stream");
  });

  test("returns finding for ua-parser-js", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest, {
      dependencies: [{ name: "ua-parser-js", version: "0.7.28", isDev: false }],
    });
    const findings = await check(knownVulnerablePatterns, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("ua-parser-js");
  });

  test("returns finding for colors package", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest, {
      dependencies: [{ name: "colors", version: "1.4.0", isDev: false }],
    });
    const findings = await check(knownVulnerablePatterns, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns finding for faker package", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest, {
      dependencies: [{ name: "faker", version: "5.0.0", isDev: false }],
    });
    const findings = await check(knownVulnerablePatterns, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns finding for node-ipc package", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest, {
      dependencies: [{ name: "node-ipc", version: "11.1.0", isDev: false }],
    });
    const findings = await check(knownVulnerablePatterns, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns finding for peacenotwar package", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest, {
      dependencies: [{ name: "peacenotwar", version: "1.0.0", isDev: false }],
    });
    const findings = await check(knownVulnerablePatterns, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns finding listing multiple vulnerable packages", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest, {
      dependencies: [
        { name: "event-stream", version: "3.3.4", isDev: false },
        { name: "colors", version: "1.4.0", isDev: false },
      ],
    });
    const findings = await check(knownVulnerablePatterns, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("event-stream");
    expect(findings[0]?.message).toContain("colors");
  });

  test("returns empty when no vulnerable packages present", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest, {
      dependencies: [
        { name: "zod", version: "3.0.0", isDev: false },
        { name: "typescript", version: "5.0.0", isDev: true },
      ],
    });
    const findings = await check(knownVulnerablePatterns, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when no dependencies provided", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(knownVulnerablePatterns, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(knownVulnerablePatterns?.name).toBe("supply-chain:known-vulnerable-patterns");
    expect(knownVulnerablePatterns?.category).toBe("SUPPLY_CHAIN");
    expect(knownVulnerablePatterns?.defaultSeverity).toBe("HIGH");
    expect(knownVulnerablePatterns?.owasp).toEqual(["ASI04"]);
  });
});

// ---------------------------------------------------------------------------
// supply-chain:forge-verification-disabled
// ---------------------------------------------------------------------------

describe("supply-chain:forge-verification-disabled", () => {
  test("returns finding when forge is configured without verification", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      metadata: { forge: { preset: "strict" } },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(forgeVerificationDisabled, ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "supply-chain:forge-verification-disabled",
      severity: "HIGH",
      category: "SUPPLY_CHAIN",
      owasp: ["ASI04"],
      path: "metadata.forge.verification",
    });
  });

  test("returns finding when forge has verification: false", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      metadata: { forge: { verification: false } },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(forgeVerificationDisabled, ctx);

    expect(findings).toHaveLength(1);
  });

  test("returns empty when forge has verification: true", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      metadata: { forge: { verification: true } },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(forgeVerificationDisabled, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when forge has a verification object (provider config)", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      metadata: { forge: { verification: { provider: "slsa", level: 2 } } },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(forgeVerificationDisabled, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when forge metadata is absent", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(forgeVerificationDisabled, ctx);

    expect(findings).toHaveLength(0);
  });

  test("returns empty when forge is not an object (string value)", async () => {
    const manifest: AgentManifest = {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "claude-3.5-sonnet" },
      metadata: { forge: "disabled" },
    };
    const ctx = createDoctorContext(manifest);
    const findings = await check(forgeVerificationDisabled, ctx);

    expect(findings).toHaveLength(0);
  });

  test("rule metadata is correct", () => {
    expect(forgeVerificationDisabled?.name).toBe("supply-chain:forge-verification-disabled");
    expect(forgeVerificationDisabled?.category).toBe("SUPPLY_CHAIN");
    expect(forgeVerificationDisabled?.defaultSeverity).toBe("HIGH");
    expect(forgeVerificationDisabled?.owasp).toEqual(["ASI04"]);
  });
});
