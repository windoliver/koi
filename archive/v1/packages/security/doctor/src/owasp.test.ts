import { describe, expect, test } from "bun:test";
import { computeOwaspSummary } from "./owasp.js";
import type { DoctorFinding } from "./types.js";

describe("computeOwaspSummary", () => {
  test("returns all 10 OWASP IDs with zero counts for empty findings", () => {
    const summary = computeOwaspSummary([]);
    expect(summary).toHaveLength(10);
    for (const entry of summary) {
      expect(entry.findingCount).toBe(0);
      expect(entry.maxSeverity).toBeUndefined();
    }
  });

  test("counts findings per OWASP ID", () => {
    const findings: readonly DoctorFinding[] = [
      { rule: "a", severity: "HIGH", category: "GOAL_INTEGRITY", message: "x", owasp: ["ASI01"] },
      { rule: "b", severity: "MEDIUM", category: "GOAL_INTEGRITY", message: "y", owasp: ["ASI01"] },
      { rule: "c", severity: "LOW", category: "TOOL_SAFETY", message: "z", owasp: ["ASI02"] },
    ];
    const summary = computeOwaspSummary(findings);
    const asi01 = summary.find((s) => s.id === "ASI01");
    const asi02 = summary.find((s) => s.id === "ASI02");
    expect(asi01?.findingCount).toBe(2);
    expect(asi02?.findingCount).toBe(1);
  });

  test("tracks max severity per OWASP ID", () => {
    const findings: readonly DoctorFinding[] = [
      { rule: "a", severity: "LOW", category: "GOAL_INTEGRITY", message: "x", owasp: ["ASI01"] },
      {
        rule: "b",
        severity: "CRITICAL",
        category: "GOAL_INTEGRITY",
        message: "y",
        owasp: ["ASI01"],
      },
      { rule: "c", severity: "MEDIUM", category: "GOAL_INTEGRITY", message: "z", owasp: ["ASI01"] },
    ];
    const summary = computeOwaspSummary(findings);
    const asi01 = summary.find((s) => s.id === "ASI01");
    expect(asi01?.maxSeverity).toBe("CRITICAL");
  });

  test("handles findings with multiple OWASP tags", () => {
    const findings: readonly DoctorFinding[] = [
      {
        rule: "a",
        severity: "HIGH",
        category: "TOOL_SAFETY",
        message: "x",
        owasp: ["ASI02", "ASI05"],
      },
    ];
    const summary = computeOwaspSummary(findings);
    expect(summary.find((s) => s.id === "ASI02")?.findingCount).toBe(1);
    expect(summary.find((s) => s.id === "ASI05")?.findingCount).toBe(1);
  });

  test("ignores findings without owasp tags", () => {
    const findings: readonly DoctorFinding[] = [
      { rule: "a", severity: "HIGH", category: "TOOL_SAFETY", message: "x" },
    ];
    const summary = computeOwaspSummary(findings);
    for (const entry of summary) {
      expect(entry.findingCount).toBe(0);
    }
  });

  test("OWASP IDs are in order ASI01 through ASI10", () => {
    const summary = computeOwaspSummary([]);
    const ids = summary.map((s) => s.id);
    expect(ids).toEqual([
      "ASI01",
      "ASI02",
      "ASI03",
      "ASI04",
      "ASI05",
      "ASI06",
      "ASI07",
      "ASI08",
      "ASI09",
      "ASI10",
    ]);
  });
});
