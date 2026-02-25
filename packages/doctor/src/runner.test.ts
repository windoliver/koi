import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createDoctor } from "./runner.js";
import type { DoctorConfig, DoctorRule } from "./types.js";

const MINIMAL_MANIFEST: AgentManifest = {
  name: "test",
  version: "1.0.0",
  model: { name: "claude" },
};

describe("createDoctor", () => {
  test("throws when manifest is missing", () => {
    expect(() => createDoctor({ manifest: undefined } as unknown as DoctorConfig)).toThrow();
  });

  test("creates a Doctor with run method", () => {
    const doctor = createDoctor({ manifest: MINIMAL_MANIFEST });
    expect(typeof doctor.run).toBe("function");
  });
});

describe("Doctor.run", () => {
  test("returns a report with expected shape", async () => {
    const doctor = createDoctor({ manifest: MINIMAL_MANIFEST });
    const report = await doctor.run();
    expect(report.findings).toBeDefined();
    expect(report.ruleErrors).toBeDefined();
    expect(report.rulesApplied).toBeGreaterThan(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.owaspSummary).toHaveLength(10);
    expect(typeof report.healthy).toBe("boolean");
    expect(typeof report.truncationWarning).toBe("boolean");
  });

  test("filters findings by severity threshold", async () => {
    const doctor = createDoctor({
      manifest: MINIMAL_MANIFEST,
      severityThreshold: "HIGH",
    });
    const report = await doctor.run();
    for (const finding of report.findings) {
      expect(["HIGH", "CRITICAL"]).toContain(finding.severity);
    }
  });

  test("filters rules by enabled categories", async () => {
    const doctor = createDoctor({
      manifest: MINIMAL_MANIFEST,
      enabledCategories: ["SUPPLY_CHAIN"],
    });
    const report = await doctor.run();
    for (const finding of report.findings) {
      expect(finding.category).toBe("SUPPLY_CHAIN");
    }
  });

  test("runs custom rules alongside built-in", async () => {
    const customRule: DoctorRule = {
      name: "custom:test-rule",
      category: "TOOL_SAFETY",
      defaultSeverity: "LOW",
      owasp: ["ASI02"],
      check: () => [
        {
          rule: "custom:test-rule",
          severity: "LOW",
          category: "TOOL_SAFETY",
          message: "Custom finding",
          owasp: ["ASI02"],
        },
      ],
    };
    const doctor = createDoctor({
      manifest: MINIMAL_MANIFEST,
      customRules: [customRule],
    });
    const report = await doctor.run();
    expect(report.findings.some((f) => f.rule === "custom:test-rule")).toBe(true);
  });

  test("empty enabledCategories produces empty report", async () => {
    const doctor = createDoctor({
      manifest: MINIMAL_MANIFEST,
      enabledCategories: [],
    });
    const report = await doctor.run();
    expect(report.findings).toHaveLength(0);
    expect(report.rulesApplied).toBe(0);
    expect(report.healthy).toBe(true);
  });

  test("healthy is false when CRITICAL findings exist", async () => {
    const criticalRule: DoctorRule = {
      name: "custom:critical",
      category: "TOOL_SAFETY",
      defaultSeverity: "CRITICAL",
      owasp: [],
      check: () => [
        { rule: "custom:critical", severity: "CRITICAL", category: "TOOL_SAFETY", message: "bad" },
      ],
    };
    const doctor = createDoctor({
      manifest: MINIMAL_MANIFEST,
      enabledCategories: ["TOOL_SAFETY"],
      customRules: [criticalRule],
    });
    const report = await doctor.run();
    expect(report.healthy).toBe(false);
  });

  test("healthy is false when HIGH findings exist", async () => {
    const highRule: DoctorRule = {
      name: "custom:high",
      category: "TOOL_SAFETY",
      defaultSeverity: "HIGH",
      owasp: [],
      check: () => [
        { rule: "custom:high", severity: "HIGH", category: "TOOL_SAFETY", message: "bad" },
      ],
    };
    const doctor = createDoctor({
      manifest: MINIMAL_MANIFEST,
      enabledCategories: ["TOOL_SAFETY"],
      customRules: [highRule],
    });
    const report = await doctor.run();
    expect(report.healthy).toBe(false);
  });
});
