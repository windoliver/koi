/**
 * Scanner-specific types for @koi/skill-scanner.
 *
 * All types live in L2 — no L0 changes required.
 */

import type { Program } from "oxc-parser";

// ---------------------------------------------------------------------------
// Severity & category
// ---------------------------------------------------------------------------

/**
 * Severity levels — mirrored from @koi/validation.
 * Kept local to avoid tsup DTS cross-package re-export resolution issues.
 */
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type ScanCategory =
  | "DANGEROUS_API"
  | "OBFUSCATION"
  | "EXFILTRATION"
  | "PROTOTYPE_POLLUTION"
  | "FILESYSTEM_ABUSE"
  | "SSRF"
  | "PROMPT_INJECTION"
  | "SECRETS"
  | "UNPARSEABLE";

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface ScanLocation {
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

export interface ScanFinding {
  readonly rule: string;
  readonly severity: Severity;
  readonly confidence: number;
  readonly category: ScanCategory;
  readonly message: string;
  readonly location?: ScanLocation;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ScanReport {
  readonly findings: readonly ScanFinding[];
  readonly durationMs: number;
  readonly parseErrors: number;
  readonly rulesApplied: number;
}

// ---------------------------------------------------------------------------
// Rule interface
// ---------------------------------------------------------------------------

export interface ScanContext {
  readonly program: Program;
  readonly sourceText: string;
  readonly filename: string;
  readonly config?: ScannerConfig;
}

export interface ScanRule {
  readonly name: string;
  readonly category: ScanCategory;
  readonly defaultSeverity: Severity;
  readonly check: (ctx: ScanContext) => readonly ScanFinding[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ScannerConfig {
  readonly enabledCategories?: readonly ScanCategory[];
  readonly severityThreshold?: Severity;
  readonly confidenceThreshold?: number;
  readonly trustedDomains?: readonly string[];
  /** Called when a finding is filtered out (below severity/confidence threshold). */
  readonly onFilteredFinding?: ((finding: ScanFinding) => void) | undefined;
}
