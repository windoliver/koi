/**
 * Shared severity types and utilities.
 *
 * Used by @koi/skill-scanner, @koi/doctor, and any L2 package
 * that needs severity-level comparison.
 */

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = Object.freeze({
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
});

export function severityAtOrAbove(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold];
}
