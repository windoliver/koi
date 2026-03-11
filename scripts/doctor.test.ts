import { describe, expect, test } from "bun:test";
import type { CheckResult, DoctorReport } from "./doctor.js";
import { buildReport, formatReport } from "./doctor.js";

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

describe("buildReport", () => {
  test("counts pass, warn, and FAIL correctly", () => {
    const results: readonly CheckResult[] = [
      { name: "A", status: "pass", message: "A passed", durationMs: 100 },
      { name: "B", status: "FAIL", message: "B failed", fix: "Fix B", durationMs: 200 },
      { name: "C", status: "warn", message: "C warned", durationMs: 50 },
      { name: "D", status: "pass", message: "D passed", durationMs: 10 },
    ];
    const report = buildReport(results);
    expect(report.passed).toBe(2);
    expect(report.warnings).toBe(1);
    expect(report.failures).toBe(1);
    expect(report.results).toHaveLength(4);
  });

  test("handles all-pass results", () => {
    const results: readonly CheckResult[] = [
      { name: "A", status: "pass", message: "OK", durationMs: 10 },
    ];
    const report = buildReport(results);
    expect(report.passed).toBe(1);
    expect(report.warnings).toBe(0);
    expect(report.failures).toBe(0);
  });

  test("handles empty results", () => {
    const report = buildReport([]);
    expect(report.passed).toBe(0);
    expect(report.warnings).toBe(0);
    expect(report.failures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatReport
// ---------------------------------------------------------------------------

describe("formatReport", () => {
  test("formats pass/fail/warn with icons and duration", () => {
    const report: DoctorReport = {
      results: [
        { name: "Layers", status: "pass", message: "Layer boundaries passed", durationMs: 150 },
        {
          name: "Types",
          status: "FAIL",
          message: "Type errors found",
          fix: "Run: bun run typecheck",
          durationMs: 3200,
        },
      ],
      passed: 1,
      warnings: 0,
      failures: 1,
    };
    const output = formatReport(report);
    expect(output).toContain("[pass] Layer boundaries passed (150ms)");
    expect(output).toContain("[FAIL] Type errors found (3200ms)");
    expect(output).toContain("Fix: Run: bun run typecheck");
    expect(output).toContain("Summary: 1 passed, 0 warning(s), 1 failure(s)");
  });

  test("omits Fix line when no fix provided", () => {
    const report: DoctorReport = {
      results: [{ name: "A", status: "pass", message: "All good", durationMs: 10 }],
      passed: 1,
      warnings: 0,
      failures: 0,
    };
    const output = formatReport(report);
    expect(output).not.toContain("Fix:");
  });

  test("formats empty report", () => {
    const report: DoctorReport = { results: [], passed: 0, warnings: 0, failures: 0 };
    const output = formatReport(report);
    expect(output).toContain("Summary: 0 passed, 0 warning(s), 0 failure(s)");
  });
});
