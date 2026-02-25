/**
 * Configuration validation and defaults for @koi/doctor.
 */

import { KoiRuntimeError } from "@koi/errors";
import type { Severity } from "@koi/validation";
import { severityAtOrAbove } from "@koi/validation";
import type { DoctorCategory, DoctorConfig, ResolvedDoctorConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_CATEGORIES: readonly DoctorCategory[] = [
  "GOAL_INTEGRITY",
  "TOOL_SAFETY",
  "ACCESS_CONTROL",
  "SUPPLY_CHAIN",
  "RESILIENCE",
];

const DEFAULT_RULE_TIMEOUT_MS = 5_000;
const DEFAULT_GLOBAL_TIMEOUT_MS = 30_000;
const DEFAULT_SEVERITY_THRESHOLD: Severity = "LOW";
const DEFAULT_MAX_FINDINGS = 500;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateDoctorConfig(config: DoctorConfig): void {
  if (config.manifest === undefined || config.manifest === null) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      "DoctorConfig.manifest is required — provide an AgentManifest to scan",
    );
  }

  if (config.ruleTimeoutMs !== undefined && config.ruleTimeoutMs <= 0) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `DoctorConfig.ruleTimeoutMs must be positive, got ${String(config.ruleTimeoutMs)}`,
    );
  }

  if (config.timeoutMs !== undefined && config.timeoutMs <= 0) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `DoctorConfig.timeoutMs must be positive, got ${String(config.timeoutMs)}`,
    );
  }

  if (config.maxFindings !== undefined && config.maxFindings <= 0) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `DoctorConfig.maxFindings must be positive, got ${String(config.maxFindings)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export function resolveConfig(config: DoctorConfig): ResolvedDoctorConfig {
  return {
    manifest: config.manifest,
    dependencies: config.dependencies ?? [],
    envKeys: config.envKeys,
    enabledCategories: config.enabledCategories ?? ALL_CATEGORIES,
    severityThreshold: config.severityThreshold ?? DEFAULT_SEVERITY_THRESHOLD,
    severityOverrides: config.severityOverrides ?? {},
    ruleTimeoutMs: config.ruleTimeoutMs ?? DEFAULT_RULE_TIMEOUT_MS,
    timeoutMs: config.timeoutMs ?? DEFAULT_GLOBAL_TIMEOUT_MS,
    customRules: config.customRules ?? [],
    maxFindings: config.maxFindings ?? DEFAULT_MAX_FINDINGS,
    advisoryCallback: config.advisoryCallback,
  };
}

// ---------------------------------------------------------------------------
// Threshold check
// ---------------------------------------------------------------------------

export function meetsSeverityThreshold(severity: Severity, threshold: Severity): boolean {
  return severityAtOrAbove(severity, threshold);
}
