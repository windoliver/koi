/**
 * Scanner factory — the main public API of @koi/skill-scanner.
 *
 * Creates a scanner instance that parses code, runs all enabled rules,
 * and returns a filtered ScanReport.
 */

import { meetsThresholds, resolveConfig } from "./config.js";
import type { ParseOutput } from "./parse.js";
import { parseCode } from "./parse.js";
import { getBuiltinRules, getTextRules } from "./rules/index.js";
import { extractCodeBlocks } from "./skill-scanner.js";
import type { ScanFinding, ScannerConfig, ScanReport } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Scanner {
  readonly scan: (sourceText: string, filename?: string) => ScanReport;
  readonly scanSkill: (markdown: string) => ScanReport;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScanner(config?: ScannerConfig): Scanner {
  const resolved = resolveConfig(config);
  const enabledCategories = new Set(resolved.enabledCategories);
  const rules = getBuiltinRules().filter((r) => enabledCategories.has(r.category));
  const textRules = getTextRules().filter((r) => enabledCategories.has(r.category));

  // Lazily cached empty parse for text rules (avoids re-parsing "" on every scanSkill call)
  // let: lazily initialized on first scanSkill call
  let emptyParseCache: ParseOutput | undefined;
  function getEmptyParse(): ParseOutput {
    if (emptyParseCache === undefined) {
      emptyParseCache = parseCode("");
    }
    return emptyParseCache;
  }

  function scan(sourceText: string, filename = "input.ts"): ScanReport {
    const start = performance.now();

    // 1. Parse
    const parseOutput = parseCode(sourceText, filename);

    // 2. Run rules sequentially against the AST
    const ruleFindings: ScanFinding[] = [];
    for (const rule of rules) {
      const results = rule.check({
        program: parseOutput.program,
        sourceText,
        filename,
        config: resolved,
      });
      for (const finding of results) {
        ruleFindings.push(finding);
      }
    }

    // 3. Combine parse error findings + rule findings
    const allFindings = [...parseOutput.findings, ...ruleFindings];

    // 4. Filter by thresholds
    const filtered = allFindings.filter((f) => meetsThresholds(f.severity, f.confidence, resolved));

    const durationMs = performance.now() - start;

    return {
      findings: filtered,
      durationMs,
      parseErrors: parseOutput.findings.length,
      rulesApplied: rules.length,
    };
  }

  function scanSkill(markdown: string): ScanReport {
    const start = performance.now();
    const codeBlocks = extractCodeBlocks(markdown);
    const allFindings: ScanFinding[] = [];
    // let: accumulated across code block iterations
    let totalParseErrors = 0;
    let totalRulesApplied = 0;

    for (const block of codeBlocks) {
      const report = scan(block.code, block.filename);
      for (const finding of report.findings) {
        // Adjust line numbers to account for code block position in markdown
        const adjusted: ScanFinding =
          finding.location !== undefined
            ? {
                ...finding,
                location: {
                  ...finding.location,
                  line: finding.location.line + block.startLine,
                },
              }
            : finding;
        allFindings.push(adjusted);
      }
      totalParseErrors += report.parseErrors;
      totalRulesApplied = Math.max(totalRulesApplied, report.rulesApplied);
    }

    // Run text-based rules (prompt injection) on full markdown
    if (textRules.length > 0) {
      const emptyParse = getEmptyParse();
      for (const rule of textRules) {
        const results = rule.check({
          program: emptyParse.program,
          sourceText: markdown,
          filename: "skill.md",
          config: resolved,
        });
        for (const finding of results) {
          if (meetsThresholds(finding.severity, finding.confidence, resolved)) {
            allFindings.push(finding);
          }
        }
      }
      totalRulesApplied += textRules.length;
    }

    const durationMs = performance.now() - start;

    return {
      findings: allFindings,
      durationMs,
      parseErrors: totalParseErrors,
      rulesApplied: totalRulesApplied,
    };
  }

  return { scan, scanSkill };
}
