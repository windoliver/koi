/**
 * Scanner configuration validation and defaults.
 */

import type { ScannerConfig, Severity } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

const DEFAULT_CONFIG: Required<ScannerConfig> = {
  enabledCategories: [
    "DANGEROUS_API",
    "OBFUSCATION",
    "EXFILTRATION",
    "PROTOTYPE_POLLUTION",
    "FILESYSTEM_ABUSE",
    "SSRF",
    "PROMPT_INJECTION",
    "SECRETS",
    "UNPARSEABLE",
  ],
  severityThreshold: "LOW",
  confidenceThreshold: 0.0,
  trustedDomains: [],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function resolveConfig(config?: ScannerConfig): Required<ScannerConfig> {
  if (config === undefined) return DEFAULT_CONFIG;

  return {
    enabledCategories: config.enabledCategories ?? DEFAULT_CONFIG.enabledCategories,
    severityThreshold: config.severityThreshold ?? DEFAULT_CONFIG.severityThreshold,
    confidenceThreshold: config.confidenceThreshold ?? DEFAULT_CONFIG.confidenceThreshold,
    trustedDomains: config.trustedDomains ?? DEFAULT_CONFIG.trustedDomains,
  };
}

export function severityAtOrAbove(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold];
}

export function meetsThresholds(
  severity: Severity,
  confidence: number,
  config: Required<ScannerConfig>,
): boolean {
  return (
    severityAtOrAbove(severity, config.severityThreshold) &&
    confidence >= config.confidenceThreshold
  );
}
