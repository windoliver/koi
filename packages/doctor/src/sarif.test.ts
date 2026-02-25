import { describe, expect, test } from "bun:test";
import { mapDoctorReportToSarif } from "./sarif.js";
import type { DoctorReport } from "./types.js";

function createEmptyReport(): DoctorReport {
  return {
    findings: [],
    ruleErrors: [],
    rulesApplied: 0,
    durationMs: 10,
    owaspSummary: [],
    healthy: true,
    truncationWarning: false,
  };
}

describe("mapDoctorReportToSarif", () => {
  test("produces valid SARIF 2.1.0 structure", () => {
    const sarif = mapDoctorReportToSarif(createEmptyReport());
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toContain("sarif-schema-2.1.0");
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0]?.tool.driver.name).toBe("@koi/doctor");
  });

  test("uses provided version", () => {
    const sarif = mapDoctorReportToSarif(createEmptyReport(), "1.2.3");
    expect(sarif.runs[0]?.tool.driver.version).toBe("1.2.3");
  });

  test("defaults version to 0.0.0", () => {
    const sarif = mapDoctorReportToSarif(createEmptyReport());
    expect(sarif.runs[0]?.tool.driver.version).toBe("0.0.0");
  });

  test("maps CRITICAL severity to error level", () => {
    const report: DoctorReport = {
      ...createEmptyReport(),
      findings: [
        { rule: "test:critical", severity: "CRITICAL", category: "TOOL_SAFETY", message: "bad" },
      ],
    };
    const sarif = mapDoctorReportToSarif(report);
    expect(sarif.runs[0]?.results[0]?.level).toBe("error");
  });

  test("maps HIGH severity to error level", () => {
    const report: DoctorReport = {
      ...createEmptyReport(),
      findings: [{ rule: "test:high", severity: "HIGH", category: "TOOL_SAFETY", message: "bad" }],
    };
    const sarif = mapDoctorReportToSarif(report);
    expect(sarif.runs[0]?.results[0]?.level).toBe("error");
  });

  test("maps MEDIUM severity to warning level", () => {
    const report: DoctorReport = {
      ...createEmptyReport(),
      findings: [
        { rule: "test:medium", severity: "MEDIUM", category: "TOOL_SAFETY", message: "meh" },
      ],
    };
    const sarif = mapDoctorReportToSarif(report);
    expect(sarif.runs[0]?.results[0]?.level).toBe("warning");
  });

  test("maps LOW severity to note level", () => {
    const report: DoctorReport = {
      ...createEmptyReport(),
      findings: [{ rule: "test:low", severity: "LOW", category: "TOOL_SAFETY", message: "info" }],
    };
    const sarif = mapDoctorReportToSarif(report);
    expect(sarif.runs[0]?.results[0]?.level).toBe("note");
  });

  test("includes fix in message when present", () => {
    const report: DoctorReport = {
      ...createEmptyReport(),
      findings: [
        { rule: "test", severity: "HIGH", category: "TOOL_SAFETY", message: "bad", fix: "do this" },
      ],
    };
    const sarif = mapDoctorReportToSarif(report);
    expect(sarif.runs[0]?.results[0]?.message.text).toContain("Fix: do this");
  });

  test("includes location when path is present", () => {
    const report: DoctorReport = {
      ...createEmptyReport(),
      findings: [
        {
          rule: "test",
          severity: "HIGH",
          category: "TOOL_SAFETY",
          message: "bad",
          path: "middleware",
        },
      ],
    };
    const sarif = mapDoctorReportToSarif(report);
    const locations = sarif.runs[0]?.results[0]?.locations;
    expect(locations).toHaveLength(1);
    expect(locations?.[0]?.physicalLocation?.artifactLocation?.uri).toBe("middleware");
  });

  test("omits locations when path is absent", () => {
    const report: DoctorReport = {
      ...createEmptyReport(),
      findings: [{ rule: "test", severity: "LOW", category: "SUPPLY_CHAIN", message: "info" }],
    };
    const sarif = mapDoctorReportToSarif(report);
    expect(sarif.runs[0]?.results[0]?.locations).toBeUndefined();
  });

  test("empty findings produce empty results", () => {
    const sarif = mapDoctorReportToSarif(createEmptyReport());
    expect(sarif.runs[0]?.results).toHaveLength(0);
  });
});
