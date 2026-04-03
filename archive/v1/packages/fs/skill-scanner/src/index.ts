/**
 * @koi/skill-scanner — AST-based malicious code detection for Koi forge.
 *
 * L2 package (oxc-parser as sole external dependency).
 */

export type {
  ForgeContextCompat,
  ForgeInputCompat,
  ForgeVerifierCompat,
  VerifierResultCompat,
} from "./forge-adapter.js";
// ForgeVerifier adapter
export { createScannerVerifier } from "./forge-adapter.js";
// Individual rules (for advanced users)
export { getBuiltinRules, getRulesByCategory, getTextRules } from "./rules/index.js";
export type { Scanner } from "./scanner.js";
// Factory
export { createScanner } from "./scanner.js";
// Types
export type {
  ScanCategory,
  ScanContext,
  ScanFinding,
  ScanLocation,
  ScannerConfig,
  ScanReport,
  ScanRule,
  Severity,
} from "./types.js";
