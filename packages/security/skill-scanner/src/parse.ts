/**
 * Error-tolerant oxc-parser wrapper.
 *
 * Returns a parsed AST alongside any parse-error findings.
 * oxc-parser is error-tolerant — partial ASTs are still usable for analysis.
 */

import type { Program } from "oxc-parser";
import { parseSync } from "oxc-parser";
import type { ScanFinding } from "./types.js";
import { offsetToLocation } from "./walker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParseOutput {
  readonly program: Program;
  readonly findings: readonly ScanFinding[];
  readonly hasErrors: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseCode(sourceText: string, filename = "input.ts"): ParseOutput {
  const result = parseSync(filename, sourceText, {
    sourceType: "module",
    lang: inferLang(filename),
  });

  const errors = result.errors;
  const findings: readonly ScanFinding[] = errors.map((err) => {
    const label = err.labels[0];
    const location = label !== undefined ? offsetToLocation(sourceText, label.start) : undefined;

    return {
      rule: "parse-error",
      severity: "HIGH",
      confidence: 1.0,
      category: "UNPARSEABLE",
      message: `Parse error: ${err.message}${err.helpMessage ? ` — ${err.helpMessage}` : ""}`,
      ...(location !== undefined ? { location } : {}),
    };
  });

  return {
    program: result.program,
    findings,
    hasErrors: errors.length > 0,
  };
}

function inferLang(filename: string): "ts" | "tsx" | "js" | "jsx" {
  if (filename.endsWith(".tsx")) return "tsx";
  if (filename.endsWith(".jsx")) return "jsx";
  if (filename.endsWith(".js")) return "js";
  return "ts";
}
