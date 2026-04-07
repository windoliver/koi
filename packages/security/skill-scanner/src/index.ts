/**
 * @koi/skill-scanner — AST-based malicious code detection for Koi skills.
 *
 * L0u package (oxc-parser as sole external dependency).
 */

// Individual rules (for advanced users)
export {
  getBuiltinRules,
  getRulesByCategory,
  getServerRules,
  getTextRules,
} from "./rules/index.js";
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
