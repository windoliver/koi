/**
 * Scanner configuration validation and defaults.
 */

import { severityAtOrAbove as _severityAtOrAbove } from "@koi/validation";
import type { ScannerConfig, Severity } from "./types.js";

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
  return _severityAtOrAbove(severity, threshold);
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
