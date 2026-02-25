/**
 * Public type definitions for @koi/doctor — security scanner + deployment audits.
 *
 * All types are immutable (readonly). No runtime code in this file.
 */

import type { AgentManifest, DelegationConfig, PermissionConfig } from "@koi/core";
import type { Severity } from "@koi/validation";

// ---------------------------------------------------------------------------
// Categories & OWASP mapping
// ---------------------------------------------------------------------------

export type DoctorCategory =
  | "GOAL_INTEGRITY"
  | "TOOL_SAFETY"
  | "ACCESS_CONTROL"
  | "SUPPLY_CHAIN"
  | "RESILIENCE";

export type OwaspAgenticId =
  | "ASI01"
  | "ASI02"
  | "ASI03"
  | "ASI04"
  | "ASI05"
  | "ASI06"
  | "ASI07"
  | "ASI08"
  | "ASI09"
  | "ASI10";

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface DoctorFinding {
  readonly rule: string;
  readonly severity: Severity;
  readonly category: DoctorCategory;
  readonly message: string;
  readonly fix?: string;
  readonly owasp?: readonly OwaspAgenticId[];
  readonly path?: string;
}

export interface DoctorRuleError {
  readonly rule: string;
  readonly message: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

// ---------------------------------------------------------------------------
// OWASP coverage
// ---------------------------------------------------------------------------

export interface OwaspCoverage {
  readonly id: OwaspAgenticId;
  readonly findingCount: number;
  readonly maxSeverity: Severity | undefined;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface DoctorReport {
  readonly findings: readonly DoctorFinding[];
  readonly ruleErrors: readonly DoctorRuleError[];
  readonly rulesApplied: number;
  readonly durationMs: number;
  readonly owaspSummary: readonly OwaspCoverage[];
  readonly healthy: boolean;
  readonly truncationWarning: boolean;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DependencyEntry {
  readonly name: string;
  readonly version: string;
  readonly isDev: boolean;
}

// ---------------------------------------------------------------------------
// Context (lazy memoized accessors)
// ---------------------------------------------------------------------------

export interface DoctorContext {
  readonly manifest: AgentManifest;
  readonly middlewareNames: () => ReadonlySet<string>;
  readonly toolNames: () => ReadonlySet<string>;
  readonly dependencies: () => readonly DependencyEntry[];
  readonly envKeys: () => ReadonlySet<string>;
  readonly permissions: PermissionConfig | undefined;
  readonly delegation: DelegationConfig | undefined;
  readonly packageJson?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Rule interface
// ---------------------------------------------------------------------------

export interface DoctorRule {
  readonly name: string;
  readonly category: DoctorCategory;
  readonly defaultSeverity: Severity;
  readonly owasp: readonly OwaspAgenticId[];
  readonly check: (
    ctx: DoctorContext,
  ) => readonly DoctorFinding[] | Promise<readonly DoctorFinding[]>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Async callback that returns advisory findings for declared dependencies.
 * Callers can plug in `npm audit`, OSV, Snyk, or any other vulnerability feed.
 */
export type AdvisoryCallback = (
  deps: readonly DependencyEntry[],
) => readonly DoctorFinding[] | Promise<readonly DoctorFinding[]>;

export interface DoctorConfig {
  readonly manifest: AgentManifest;
  readonly dependencies?: readonly DependencyEntry[];
  readonly envKeys?: ReadonlySet<string>;
  readonly enabledCategories?: readonly DoctorCategory[];
  readonly severityThreshold?: Severity;
  readonly severityOverrides?: Readonly<Record<string, Severity>>;
  readonly ruleTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly customRules?: readonly DoctorRule[];
  readonly maxFindings?: number;
  readonly advisoryCallback?: AdvisoryCallback;
}

export interface ResolvedDoctorConfig {
  readonly manifest: AgentManifest;
  readonly dependencies: readonly DependencyEntry[];
  readonly envKeys: ReadonlySet<string> | undefined;
  readonly enabledCategories: readonly DoctorCategory[];
  readonly severityThreshold: Severity;
  readonly severityOverrides: Readonly<Record<string, Severity>>;
  readonly ruleTimeoutMs: number;
  readonly timeoutMs: number;
  readonly customRules: readonly DoctorRule[];
  readonly maxFindings: number;
  readonly advisoryCallback: AdvisoryCallback | undefined;
}

// ---------------------------------------------------------------------------
// Doctor API
// ---------------------------------------------------------------------------

export interface Doctor {
  readonly run: () => Promise<DoctorReport>;
}

// ---------------------------------------------------------------------------
// SARIF types (minimal subset for CI integration)
// ---------------------------------------------------------------------------

export interface SarifMessage {
  readonly text: string;
}

export interface SarifArtifactLocation {
  readonly uri?: string;
}

export interface SarifPhysicalLocation {
  readonly artifactLocation?: SarifArtifactLocation;
}

export interface SarifLocation {
  readonly physicalLocation?: SarifPhysicalLocation;
}

export interface SarifResult {
  readonly ruleId: string;
  readonly level: "error" | "warning" | "note" | "none";
  readonly message: SarifMessage;
  readonly locations?: readonly SarifLocation[];
}

export interface SarifToolDriver {
  readonly name: string;
  readonly version: string;
}

export interface SarifTool {
  readonly driver: SarifToolDriver;
}

export interface SarifRun {
  readonly tool: SarifTool;
  readonly results: readonly SarifResult[];
}

export interface SarifLog {
  readonly $schema: string;
  readonly version: string;
  readonly runs: readonly SarifRun[];
}
