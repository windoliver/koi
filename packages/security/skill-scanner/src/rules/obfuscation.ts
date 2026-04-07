/**
 * Rule: obfuscation
 *
 * Detects code obfuscation patterns: hex/unicode escape density,
 * string concatenation for API names, computed property access
 * with concatenation, and array-based string storage.
 */

import type { BinaryExpression, Expression } from "oxc-parser";
import type { ScanContext, ScanFinding, ScanRule } from "../types.js";
import { offsetToLocation, visitAst } from "../walker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEX_ESCAPE_RE = /\\x[0-9a-fA-F]{2}/g;
const UNICODE_ESCAPE_RE = /\\u[0-9a-fA-F]{4}/g;
const UNICODE_BRACE_ESCAPE_RE = /\\u\{[0-9a-fA-F]+\}/g;

/** Threshold: if >20% of characters in string literals are escape sequences */
const ESCAPE_DENSITY_THRESHOLD = 0.2;

/** Known dangerous API names that might be built via concatenation */
const DANGEROUS_NAMES = new Set([
  "eval",
  "Function",
  "require",
  "child_process",
  "exec",
  "execSync",
  "spawn",
  "spawnSync",
  "setTimeout",
  "setInterval",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countEscapes(raw: string): number {
  const hex = raw.match(HEX_ESCAPE_RE)?.length ?? 0;
  const unicode = raw.match(UNICODE_ESCAPE_RE)?.length ?? 0;
  const unicodeBrace = raw.match(UNICODE_BRACE_ESCAPE_RE)?.length ?? 0;
  return hex + unicode + unicodeBrace;
}

/** Max recursion depth for nested concatenation resolution */
const MAX_CONCAT_DEPTH = 10;

function resolveStringConcat(node: BinaryExpression, depth = 0): string | undefined {
  if (depth > MAX_CONCAT_DEPTH) return undefined;
  if (node.operator !== "+") return undefined;

  const leftVal = resolveStringPart(node.left, depth + 1);
  const rightVal = resolveStringPart(node.right, depth + 1);

  if (leftVal === undefined || rightVal === undefined) return undefined;
  return leftVal + rightVal;
}

function resolveStringPart(node: Expression, depth = 0): string | undefined {
  if (node.type === "Literal" && "value" in node && typeof node.value === "string") {
    return node.value;
  }
  // PrivateInExpression shares type "BinaryExpression" — cast needed to exclude it
  // (resolveStringConcat rejects non-"+" operators at runtime)
  if (node.type === "BinaryExpression") {
    return resolveStringConcat(node as BinaryExpression, depth);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rule implementation
// ---------------------------------------------------------------------------

function check(ctx: ScanContext): readonly ScanFinding[] {
  const findings: ScanFinding[] = [];
  // let: accumulated across visitor callbacks
  let totalStringChars = 0;
  let totalEscapeChars = 0;
  let stringLiteralCount = 0;
  const statementCount = ctx.program.body.length;

  visitAst(ctx.program, {
    onStringLiteral(node) {
      stringLiteralCount++;
      const raw = node.raw ?? "";
      const escapes = countEscapes(raw);
      const escapeChars = escapes * 4; // approximate chars per escape
      totalEscapeChars += escapeChars;
      totalStringChars += raw.length;

      // Per-literal high escape density
      if (raw.length > 8 && escapes > 0) {
        const density = escapeChars / raw.length;
        if (density > ESCAPE_DENSITY_THRESHOLD) {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: "obfuscation:escape-density",
            severity: "HIGH",
            confidence: Math.min(0.5 + density, 0.9),
            category: "OBFUSCATION",
            message: `String literal with ${(density * 100).toFixed(0)}% escape sequences (${escapes} escapes in ${raw.length} chars)`,
            location: loc,
          });
        }
      }
    },

    onBinaryExpression(node) {
      if (node.operator !== "+") return;

      const resolved = resolveStringConcat(node);
      if (resolved === undefined) return;

      // Check if concatenation produces a known dangerous API name
      if (DANGEROUS_NAMES.has(resolved)) {
        const loc = offsetToLocation(ctx.sourceText, node.start);
        findings.push({
          rule: "obfuscation:string-concat-api",
          severity: "CRITICAL",
          confidence: 0.9,
          category: "OBFUSCATION",
          message: `String concatenation constructs dangerous API name: "${resolved}"`,
          location: loc,
        });
      }
    },

    onMemberExpression(node) {
      // Computed property access with string concatenation: window["ev" + "al"]
      if (!node.computed) return;

      // computed: true narrows to ComputedMemberExpression where property is Expression
      const prop = node.property;
      if (prop.type === "BinaryExpression") {
        // PrivateInExpression shares type "BinaryExpression" — cast excludes it
        const resolved = resolveStringConcat(prop as BinaryExpression);
        if (resolved !== undefined && DANGEROUS_NAMES.has(resolved)) {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: "obfuscation:computed-property-concat",
            severity: "CRITICAL",
            confidence: 0.9,
            category: "OBFUSCATION",
            message: `Computed property access constructs dangerous API name: ["${resolved}"]`,
            location: loc,
          });
        }
      }
    },
  });

  // Global escape density check
  if (totalStringChars > 50) {
    const globalDensity = totalEscapeChars / totalStringChars;
    if (globalDensity > ESCAPE_DENSITY_THRESHOLD) {
      findings.push({
        rule: "obfuscation:global-escape-density",
        severity: "HIGH",
        confidence: 0.8,
        category: "OBFUSCATION",
        message: `Code has ${(globalDensity * 100).toFixed(0)}% escape sequence density across all string literals`,
      });
    }
  }

  // Unusually high string-to-statement ratio (obfuscator signature)
  if (statementCount > 0 && stringLiteralCount > statementCount * 5) {
    findings.push({
      rule: "obfuscation:high-string-ratio",
      severity: "MEDIUM",
      confidence: 0.5,
      category: "OBFUSCATION",
      message: `Unusually high string literal count (${stringLiteralCount}) relative to statements (${statementCount})`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const obfuscationRule: ScanRule = {
  name: "obfuscation",
  category: "OBFUSCATION",
  defaultSeverity: "HIGH",
  check,
};
