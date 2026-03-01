/**
 * Rules-based SecurityAnalyzer implementation.
 *
 * Matches tool input against configurable high/medium risk patterns using
 * pre-compiled RegExps. Sub-millisecond per call — no caching needed.
 */

import type { JsonObject, RiskAnalysis, RiskFinding, RiskLevel, SecurityAnalyzer } from "@koi/core";
import { RISK_LEVEL_ORDER } from "@koi/core";

// ---------------------------------------------------------------------------
// Default pattern sets
// ---------------------------------------------------------------------------

export const DEFAULT_HIGH_RISK_PATTERNS: readonly string[] = [
  "rm -rf",
  "sudo",
  "chmod 777",
  "chmod +s",
  "> /dev/",
  "dd if=",
  "mkfs",
  "shred",
  ":(){:|:&};:",
  "eval(",
  "exec(",
];

export const DEFAULT_MEDIUM_RISK_PATTERNS: readonly string[] = [
  "curl",
  "wget",
  "git clone",
  "npm install",
  "pip install",
  "apt-get",
  "brew install",
  "chmod",
  "chown",
];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RulesAnalyzerConfig {
  /**
   * Extract a command string from toolId + input for pattern matching.
   * Defaults to defaultExtractCommand.
   */
  readonly extractCommand?: (toolId: string, input: JsonObject) => string;
  /** Override default high-risk patterns. */
  readonly highPatterns?: readonly string[];
  /** Override default medium-risk patterns. */
  readonly mediumPatterns?: readonly string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a literal string for use in a RegExp pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledPattern {
  readonly pattern: string;
  readonly re: RegExp;
  readonly riskLevel: RiskLevel;
}

function compilePatterns(
  patterns: readonly string[],
  riskLevel: RiskLevel,
): readonly CompiledPattern[] {
  return patterns.map((p) => ({
    pattern: p,
    re: new RegExp(escapeRegExp(p), "i"),
    riskLevel,
  }));
}

/**
 * Compute the maximum risk level across a set of levels.
 * "unknown" is treated as the lowest severity.
 */
export function maxRiskLevel(levels: readonly RiskLevel[]): RiskLevel {
  if (levels.length === 0) return "low";
  let maxIdx = 0;
  for (const level of levels) {
    const idx = RISK_LEVEL_ORDER.indexOf(level);
    if (idx > maxIdx) maxIdx = idx;
  }
  return RISK_LEVEL_ORDER[maxIdx] ?? "unknown";
}

/**
 * Default command extractor: looks for `command`, `cmd`, `args` fields,
 * then falls back to JSON-serializing the whole input.
 */
export function defaultExtractCommand(toolId: string, input: JsonObject): string {
  const parts: string[] = [toolId];
  if (typeof input.command === "string") {
    parts.push(input.command);
  } else if (typeof input.cmd === "string") {
    parts.push(input.cmd);
  } else if (typeof input.args === "string") {
    parts.push(input.args);
  } else {
    parts.push(JSON.stringify(input));
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a synchronous rules-based SecurityAnalyzer.
 *
 * Patterns are pre-compiled at construction time (not per call).
 * Returns RiskAnalysis synchronously — no I/O, no async.
 */
export function createRulesSecurityAnalyzer(config: RulesAnalyzerConfig = {}): SecurityAnalyzer {
  const highPatterns = config.highPatterns ?? DEFAULT_HIGH_RISK_PATTERNS;
  const mediumPatterns = config.mediumPatterns ?? DEFAULT_MEDIUM_RISK_PATTERNS;
  const extract = config.extractCommand ?? defaultExtractCommand;

  const compiled: readonly CompiledPattern[] = [
    ...compilePatterns(highPatterns, "high"),
    ...compilePatterns(mediumPatterns, "medium"),
  ];

  return {
    analyze(toolId: string, input: JsonObject): RiskAnalysis {
      const command = extract(toolId, input);
      const findings: RiskFinding[] = [];

      for (const { pattern, re, riskLevel } of compiled) {
        if (re.test(command)) {
          findings.push({
            pattern,
            description: `${riskLevel === "high" ? "High" : "Medium"}-risk pattern matched: ${pattern}`,
            riskLevel,
          });
        }
      }

      const riskLevel =
        findings.length > 0 ? maxRiskLevel(findings.map((f) => f.riskLevel)) : "low";
      const rationale =
        findings.length > 0
          ? `${findings.length} pattern(s) matched`
          : "no risky patterns detected";

      return { riskLevel, findings, rationale };
    },
  };
}
