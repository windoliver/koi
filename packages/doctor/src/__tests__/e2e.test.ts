/**
 * End-to-end test: maximally insecure manifest triggers all 10 OWASP categories.
 */

import { describe, expect, test } from "bun:test";
import { createDoctor } from "../runner.js";
import { createInsecureManifest } from "./fixtures.js";

describe("e2e: OWASP coverage", () => {
  test("insecure manifest triggers findings for all 10 OWASP Agentic IDs", async () => {
    const doctor = createDoctor({
      manifest: createInsecureManifest(),
      dependencies: [
        { name: "event-stream", version: "3.3.6", isDev: false },
        ...Array.from({ length: 55 }, (_, i) => ({
          name: `dep-${String(i)}`,
          version: "1.0.0",
          isDev: false,
        })),
      ],
    });

    const report = await doctor.run();

    // Verify all 10 OWASP IDs have at least one finding
    for (const entry of report.owaspSummary) {
      expect(entry.findingCount).toBeGreaterThan(0);
    }

    // Verify the report is unhealthy
    expect(report.healthy).toBe(false);

    // Verify we have findings from all 5 categories
    const categories = new Set(report.findings.map((f) => f.category));
    expect(categories.has("GOAL_INTEGRITY")).toBe(true);
    expect(categories.has("TOOL_SAFETY")).toBe(true);
    expect(categories.has("ACCESS_CONTROL")).toBe(true);
    expect(categories.has("SUPPLY_CHAIN")).toBe(true);
    expect(categories.has("RESILIENCE")).toBe(true);
  });

  test("SARIF export covers all findings from insecure manifest", async () => {
    const { mapDoctorReportToSarif } = await import("../sarif.js");
    const doctor = createDoctor({
      manifest: createInsecureManifest(),
    });
    const report = await doctor.run();
    const sarif = mapDoctorReportToSarif(report, "0.0.0");

    expect(sarif.runs[0]?.results.length).toBe(report.findings.length);

    // Every SARIF result should have a valid level
    for (const result of sarif.runs[0]?.results ?? []) {
      expect(["error", "warning", "note"]).toContain(result.level);
    }
  });

  test("all 30 built-in rules are applied against full manifest", async () => {
    const doctor = createDoctor({
      manifest: createInsecureManifest(),
    });
    const report = await doctor.run();
    expect(report.rulesApplied).toBe(30);
  });
});
