/**
 * SARIF 2.1.0 export for CI integration.
 *
 * Maps DoctorReport findings to the SARIF static analysis format
 * for consumption by GitHub Advanced Security, VS Code, etc.
 */

import type { Severity } from "@koi/validation";
import type { DoctorReport, SarifLog, SarifResult } from "./types.js";

// ---------------------------------------------------------------------------
// Severity → SARIF level mapping
// ---------------------------------------------------------------------------

const SARIF_LEVEL_MAP: Readonly<Record<Severity, SarifResult["level"]>> = {
  CRITICAL: "error",
  HIGH: "error",
  MEDIUM: "warning",
  LOW: "note",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function mapDoctorReportToSarif(report: DoctorReport, version?: string): SarifLog {
  const results: readonly SarifResult[] = report.findings.map((f) => ({
    ruleId: f.rule,
    level: SARIF_LEVEL_MAP[f.severity],
    message: { text: f.fix !== undefined ? `${f.message} — Fix: ${f.fix}` : f.message },
    ...(f.path !== undefined
      ? {
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.path },
              },
            },
          ],
        }
      : {}),
  }));

  return {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "@koi/doctor",
            version: version ?? "0.0.0",
          },
        },
        results,
      },
    ],
  };
}
