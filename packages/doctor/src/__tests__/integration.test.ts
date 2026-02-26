/**
 * Integration tests for @koi/doctor runner.
 *
 * 10 mandatory edge cases verifying cross-cutting behavior.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createDoctor } from "../runner.js";
import type { DoctorFinding, DoctorRule } from "../types.js";
import { createMinimalManifest } from "./fixtures.js";

// ---------------------------------------------------------------------------
// 1. Empty manifest → findings for missing security fields
// ---------------------------------------------------------------------------
describe("empty manifest", () => {
  test("produces findings for missing security fields", async () => {
    const doctor = createDoctor({ manifest: createMinimalManifest() });
    const report = await doctor.run();
    expect(report.findings.length).toBeGreaterThan(0);
    // At minimum: no permissions, no guardrails, no sanitize, no audit, etc.
    const rules = report.findings.map((f) => f.rule);
    expect(rules).toContain("goal-hijack:missing-sanitize-middleware");
    expect(rules).toContain("privilege-abuse:no-permissions-config");
  });
});

// ---------------------------------------------------------------------------
// 2. Rule throws → DoctorRuleError captured, other rules still run
// ---------------------------------------------------------------------------
describe("rule throws", () => {
  test("captures error and continues other rules", async () => {
    const throwingRule: DoctorRule = {
      name: "custom:throws",
      category: "TOOL_SAFETY",
      defaultSeverity: "HIGH",
      owasp: [],
      check: () => {
        throw new Error("Rule crashed!");
      },
    };
    const passingRule: DoctorRule = {
      name: "custom:passes",
      category: "TOOL_SAFETY",
      defaultSeverity: "LOW",
      owasp: [],
      check: () => [
        { rule: "custom:passes", severity: "LOW", category: "TOOL_SAFETY", message: "ok" },
      ],
    };
    const doctor = createDoctor({
      manifest: createMinimalManifest(),
      enabledCategories: ["TOOL_SAFETY"],
      customRules: [throwingRule, passingRule],
    });
    const report = await doctor.run();
    expect(report.ruleErrors.some((e) => e.rule === "custom:throws")).toBe(true);
    expect(report.findings.some((f) => f.rule === "custom:passes")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Rule timeout → timeout error, doesn't hang
// ---------------------------------------------------------------------------
describe("rule timeout", () => {
  test("captures timeout error without hanging", async () => {
    const slowRule: DoctorRule = {
      name: "custom:slow",
      category: "TOOL_SAFETY",
      defaultSeverity: "HIGH",
      owasp: [],
      check: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([]), 60_000);
        }),
    };
    const doctor = createDoctor({
      manifest: createMinimalManifest(),
      enabledCategories: ["TOOL_SAFETY"],
      customRules: [slowRule],
      ruleTimeoutMs: 50,
    });
    const report = await doctor.run();
    const error = report.ruleErrors.find((e) => e.rule === "custom:slow");
    expect(error).toBeDefined();
    expect(error?.timedOut).toBe(true);
  }, 5_000);
});

// ---------------------------------------------------------------------------
// 4. No rules enabled → empty report
// ---------------------------------------------------------------------------
describe("no rules enabled", () => {
  test("returns empty report with healthy=true", async () => {
    const doctor = createDoctor({
      manifest: createMinimalManifest(),
      enabledCategories: [],
    });
    const report = await doctor.run();
    expect(report.findings).toHaveLength(0);
    expect(report.ruleErrors).toHaveLength(0);
    expect(report.rulesApplied).toBe(0);
    expect(report.healthy).toBe(true);
    expect(report.truncationWarning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. All categories pass → healthy=true
// ---------------------------------------------------------------------------
describe("all categories pass", () => {
  test("fully secure manifest is healthy", async () => {
    const secureManifest: AgentManifest = {
      name: "secure",
      version: "1.0.0",
      model: { name: "claude", options: { defense: true } },
      tools: [{ name: "read_file" }],
      middleware: [
        { name: "sanitize" },
        { name: "guardrails" },
        { name: "sandbox" },
        { name: "permissions" },
        { name: "redaction" },
        { name: "call-limits" },
        { name: "budget" },
        { name: "compactor" },
        { name: "turn-ack" },
        { name: "audit" },
        { name: "governance" },
        { name: "agent-monitor" },
        { name: "a2a-auth" },
        { name: "memory" },
      ],
      permissions: {
        allow: ["read_file"],
        deny: ["exec"],
        ask: ["read_file"],
      },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      metadata: { forge: { verification: true } },
    };
    const doctor = createDoctor({
      manifest: secureManifest,
      envKeys: new Set(["DELEGATION_SECRET"]),
    });
    const report = await doctor.run();
    expect(report.healthy).toBe(true);
    expect(report.owaspSummary).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// 6. All categories fail → healthy=false
// ---------------------------------------------------------------------------
describe("all categories fail", () => {
  test("insecure manifest is unhealthy", async () => {
    const insecureManifest: AgentManifest = {
      name: "insecure",
      version: "1.0.0",
      model: { name: "claude" },
      tools: [{ name: "exec" }],
      middleware: [{ name: "memory" }],
      permissions: { allow: ["*"] },
      delegation: { enabled: true, maxChainDepth: 10, defaultTtlMs: 172_800_000 },
    };
    const doctor = createDoctor({ manifest: insecureManifest });
    const report = await doctor.run();
    expect(report.healthy).toBe(false);
    expect(report.findings.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// 7. Custom rules mixed with built-in → both run, findings merged
// ---------------------------------------------------------------------------
describe("custom + built-in rules", () => {
  test("merges findings from both rule sources", async () => {
    const customRule: DoctorRule = {
      name: "custom:check",
      category: "RESILIENCE",
      defaultSeverity: "LOW",
      owasp: ["ASI08"],
      check: () => [
        {
          rule: "custom:check",
          severity: "LOW",
          category: "RESILIENCE",
          message: "custom finding",
          owasp: ["ASI08"],
        },
      ],
    };
    const doctor = createDoctor({
      manifest: createMinimalManifest(),
      customRules: [customRule],
    });
    const report = await doctor.run();
    const builtinFindings = report.findings.filter((f) => !f.rule.startsWith("custom:"));
    const customFindings = report.findings.filter((f) => f.rule === "custom:check");
    expect(builtinFindings.length).toBeGreaterThan(0);
    expect(customFindings.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Concurrent run() calls → independent, no shared state
// ---------------------------------------------------------------------------
describe("concurrent runs", () => {
  test("produce independent reports", async () => {
    const doctor1 = createDoctor({
      manifest: createMinimalManifest(),
      enabledCategories: ["GOAL_INTEGRITY"],
    });
    const doctor2 = createDoctor({
      manifest: createMinimalManifest(),
      enabledCategories: ["SUPPLY_CHAIN"],
    });

    const [report1, report2] = await Promise.all([doctor1.run(), doctor2.run()]);

    const categories1 = new Set(report1.findings.map((f) => f.category));
    const categories2 = new Set(report2.findings.map((f) => f.category));

    if (report1.findings.length > 0) {
      expect(categories1.has("GOAL_INTEGRITY")).toBe(true);
      expect(categories1.has("SUPPLY_CHAIN")).toBe(false);
    }
    if (report2.findings.length > 0) {
      expect(categories2.has("SUPPLY_CHAIN")).toBe(true);
      expect(categories2.has("GOAL_INTEGRITY")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. SARIF export with empty findings → valid SARIF
// ---------------------------------------------------------------------------
describe("SARIF with empty findings", () => {
  test("produces valid SARIF log", async () => {
    // Import inline to keep test focused
    const { mapDoctorReportToSarif } = await import("../sarif.js");
    const doctor = createDoctor({
      manifest: createMinimalManifest(),
      enabledCategories: [],
    });
    const report = await doctor.run();
    const sarif = mapDoctorReportToSarif(report);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]?.results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Findings buffer warning → truncationWarning at 500+
// ---------------------------------------------------------------------------
describe("truncation warning", () => {
  test("sets truncationWarning when findings exceed maxFindings", async () => {
    const manyFindingsRule: DoctorRule = {
      name: "custom:many",
      category: "TOOL_SAFETY",
      defaultSeverity: "LOW",
      owasp: [],
      check: () =>
        Array.from({ length: 10 }, (_, i) => ({
          rule: "custom:many",
          severity: "LOW" as const,
          category: "TOOL_SAFETY" as const,
          message: `Finding ${String(i)}`,
        })),
    };
    const doctor = createDoctor({
      manifest: createMinimalManifest(),
      enabledCategories: ["TOOL_SAFETY"],
      customRules: [manyFindingsRule],
      maxFindings: 5,
    });
    const report = await doctor.run();
    expect(report.truncationWarning).toBe(true);
    expect(report.findings.length).toBeLessThanOrEqual(5);
  });

  test("no warning when findings are within limit", async () => {
    const doctor = createDoctor({
      manifest: createMinimalManifest(),
      enabledCategories: [],
      maxFindings: 500,
    });
    const report = await doctor.run();
    expect(report.truncationWarning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. envKeys piped through DoctorConfig → deterministic delegation check
// ---------------------------------------------------------------------------
describe("envKeys config", () => {
  test("delegation secret check passes when envKeys includes DELEGATION_SECRET", async () => {
    const manifest: AgentManifest = {
      name: "test",
      version: "1.0.0",
      model: { name: "claude" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    };
    const doctor = createDoctor({
      manifest,
      envKeys: new Set(["DELEGATION_SECRET"]),
      enabledCategories: ["ACCESS_CONTROL"],
    });
    const report = await doctor.run();
    const unsigned = report.findings.find((f) => f.rule === "insecure-delegation:unsigned-grants");
    expect(unsigned).toBeUndefined();
  });

  test("delegation secret check fires when envKeys is empty", async () => {
    const manifest: AgentManifest = {
      name: "test",
      version: "1.0.0",
      model: { name: "claude" },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    };
    const doctor = createDoctor({
      manifest,
      envKeys: new Set([]),
      enabledCategories: ["ACCESS_CONTROL"],
    });
    const report = await doctor.run();
    const unsigned = report.findings.find((f) => f.rule === "insecure-delegation:unsigned-grants");
    expect(unsigned).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 12. severityOverrides → per-rule severity tuning
// ---------------------------------------------------------------------------
describe("severity overrides", () => {
  test("overrides downgrade a rule severity", async () => {
    const doctor = createDoctor({
      manifest: createMinimalManifest(),
      enabledCategories: ["GOAL_INTEGRITY"],
      severityOverrides: { "goal-hijack:missing-sanitize-middleware": "LOW" },
    });
    const report = await doctor.run();
    const finding = report.findings.find(
      (f) => f.rule === "goal-hijack:missing-sanitize-middleware",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("LOW");
  });

  test("overrides can filter out findings via threshold", async () => {
    const doctor = createDoctor({
      manifest: createMinimalManifest(),
      enabledCategories: ["GOAL_INTEGRITY"],
      severityThreshold: "HIGH",
      severityOverrides: { "goal-hijack:missing-sanitize-middleware": "LOW" },
    });
    const report = await doctor.run();
    const finding = report.findings.find(
      (f) => f.rule === "goal-hijack:missing-sanitize-middleware",
    );
    expect(finding).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 13. advisoryCallback → supply chain vulnerability feed integration
// ---------------------------------------------------------------------------
describe("advisory callback", () => {
  test("advisory findings are merged into report and advisoryError is absent", async () => {
    const advisoryFinding: DoctorFinding = {
      rule: "advisory:CVE-2024-1234",
      severity: "CRITICAL",
      category: "SUPPLY_CHAIN",
      message: "lodash < 4.17.21 has prototype pollution",
      owasp: ["ASI04"],
    };
    const doctor = createDoctor({
      manifest: createMinimalManifest(),
      enabledCategories: [],
      advisoryCallback: () => [advisoryFinding],
    });
    const report = await doctor.run();
    expect(report.findings).toContainEqual(advisoryFinding);
    expect(report.healthy).toBe(false);
    expect(report.advisoryError).toBeUndefined();
  });

  test("async advisory callback works", async () => {
    const doctor = createDoctor({
      manifest: createMinimalManifest(),
      enabledCategories: [],
      advisoryCallback: async () => [
        {
          rule: "advisory:async-vuln",
          severity: "HIGH",
          category: "SUPPLY_CHAIN",
          message: "async vuln detected",
        },
      ],
    });
    const report = await doctor.run();
    expect(report.findings.some((f) => f.rule === "advisory:async-vuln")).toBe(true);
  });

  test("advisory callback failure is non-fatal but surfaces advisoryError", async () => {
    const doctor = createDoctor({
      manifest: createMinimalManifest(),
      enabledCategories: [],
      advisoryCallback: () => {
        throw new Error("Advisory service unavailable");
      },
    });
    const report = await doctor.run();
    expect(report.findings).toHaveLength(0);
    expect(report.healthy).toBe(true);
    expect(report.advisoryError).toBe("Advisory service unavailable");
  });
});
