/**
 * OWASP Agentic Top 10 summary aggregation.
 */

import type { Severity } from "@koi/validation";
import { SEVERITY_ORDER } from "@koi/validation";
import type { DoctorFinding, OwaspAgenticId, OwaspCoverage } from "./types.js";

// ---------------------------------------------------------------------------
// All OWASP Agentic IDs in order
// ---------------------------------------------------------------------------

const ALL_OWASP_IDS: readonly OwaspAgenticId[] = [
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
];

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function computeOwaspSummary(findings: readonly DoctorFinding[]): readonly OwaspCoverage[] {
  const counts = new Map<OwaspAgenticId, number>();
  const maxSeverities = new Map<OwaspAgenticId, Severity>();

  for (const finding of findings) {
    if (finding.owasp === undefined) continue;
    for (const id of finding.owasp) {
      counts.set(id, (counts.get(id) ?? 0) + 1);

      const current = maxSeverities.get(id);
      if (current === undefined || SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[current]) {
        maxSeverities.set(id, finding.severity);
      }
    }
  }

  return ALL_OWASP_IDS.map((id) => ({
    id,
    findingCount: counts.get(id) ?? 0,
    maxSeverity: maxSeverities.get(id),
  }));
}
