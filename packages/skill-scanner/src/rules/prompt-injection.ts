/**
 * Rule: prompt-injection
 *
 * Detects prompt injection patterns in markdown skill content.
 * This is a text-based rule — it operates on sourceText directly,
 * not on the AST. Only fires when the filename ends with `.md`.
 */

import type { ScanContext, ScanFinding, ScanRule } from "../types.js";
import { offsetToLocation } from "../walker.js";

// ---------------------------------------------------------------------------
// Pattern categories
// ---------------------------------------------------------------------------

const SYSTEM_OVERRIDE_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /forget\s+(all\s+)?(your\s+)?instructions/i,
  /disregard\s+(all\s+)?(the\s+)?above/i,
  /override\s+(system\s+)?prompt/i,
  /new\s+instructions?\s*:/i,
  /you\s+are\s+now\s+(?:a|an|the)\s/i,
  /do\s+not\s+follow\s+(any\s+)?previous/i,
  /stop\s+being\s+(?:a|an|the)\s/i,
  /reset\s+your\s+(?:instructions|context|memory)/i,
  /clear\s+(?:your\s+)?(?:context|memory|instructions)/i,
];

const ROLE_HIJACKING_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)\s*act\s+as\s+(?:a|an|the)\s/i,
  /pretend\s+(?:to\s+be|you\s+are)/i,
  /you\s+must\s+now\s/i,
  /your\s+new\s+role\s+is/i,
  /from\s+now\s+on\s*,?\s*you\s+(?:are|will)/i,
  /imagine\s+you\s+are/i,
  /roleplay\s+as\s/i,
  /switch\s+to\s+(?:a|an|the)\s/i,
  /behave\s+(?:like|as)\s+(?:a|an|the)\s/i,
];

// Data extraction — attempts to exfiltrate system prompt or internal instructions
const DATA_EXTRACTION_PATTERNS: readonly RegExp[] = [
  /repeat\s+(?:your|the)\s+(?:instructions|system\s+prompt|rules)/i,
  /show\s+(?:me\s+)?(?:your|the)\s+(?:system\s+prompt|instructions|rules)/i,
  /what\s+(?:are|were)\s+your\s+(?:instructions|rules|guidelines)/i,
  /output\s+(?:your|the)\s+(?:system\s+prompt|instructions)/i,
  /print\s+(?:your|the)\s+(?:system\s+prompt|instructions|initial\s+prompt)/i,
  /reveal\s+(?:your|the)\s+(?:system\s+prompt|instructions|hidden)/i,
];

// 5+ dashes/equals to avoid matching normal markdown HR (---)
const DELIMITER_INJECTION_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)[-]{5,}\s*\n/,
  /(?:^|\n)[=]{5,}\s*\n/,
  /(?:^|\n)[#]{5,}\s*\n/,
];

const INJECTION_KEYWORDS = /ignore|forget|override|disregard|new instructions/i;

/** Two-phase: find HTML comments first (well-behaved regex), then check content. */
function findHiddenCommentInjection(
  text: string,
): { readonly index: number; readonly match: string } | undefined {
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
    const body = m[1] ?? "";
    if (INJECTION_KEYWORDS.test(body)) {
      return { index: m.index, match: m[0].slice(0, 80) };
    }
  }
  return undefined;
}

const ZERO_WIDTH_CHAR_PATTERN = /\u200B|\u200C|\u200D|\uFEFF/;

// ---------------------------------------------------------------------------
// Pattern category metadata
// ---------------------------------------------------------------------------

interface PatternCategory {
  readonly patterns: readonly RegExp[];
  readonly severity: "HIGH" | "MEDIUM";
  readonly confidence: number;
  readonly label: string;
}

const PATTERN_CATEGORIES: readonly PatternCategory[] = [
  {
    patterns: SYSTEM_OVERRIDE_PATTERNS,
    severity: "HIGH",
    confidence: 0.75,
    label: "system override attempt",
  },
  {
    patterns: [ZERO_WIDTH_CHAR_PATTERN],
    severity: "HIGH",
    confidence: 0.8,
    label: "hidden instruction",
  },
  {
    patterns: ROLE_HIJACKING_PATTERNS,
    severity: "MEDIUM",
    confidence: 0.6,
    label: "role hijacking attempt",
  },
  {
    patterns: DATA_EXTRACTION_PATTERNS,
    severity: "MEDIUM",
    confidence: 0.65,
    label: "data extraction attempt",
  },
  {
    patterns: DELIMITER_INJECTION_PATTERNS,
    severity: "MEDIUM",
    confidence: 0.55,
    label: "delimiter injection",
  },
];

// ---------------------------------------------------------------------------
// Rule implementation
// ---------------------------------------------------------------------------

function check(ctx: ScanContext): readonly ScanFinding[] {
  // Only scan markdown files
  if (!ctx.filename.endsWith(".md")) return [];

  const text = ctx.sourceText;
  if (text.length === 0) return [];

  const findings: ScanFinding[] = [];

  // Two-phase HTML comment check (avoids ReDoS from nested [\s\S]*? patterns)
  const hiddenComment = findHiddenCommentInjection(text);
  if (hiddenComment !== undefined) {
    const loc = offsetToLocation(text, hiddenComment.index);
    findings.push({
      rule: "prompt-injection:text-scan",
      severity: "HIGH",
      confidence: 0.8,
      category: "PROMPT_INJECTION",
      message: `Potential hidden instruction detected: "${hiddenComment.match.trim().slice(0, 60)}"`,
      location: loc,
    });
  }

  for (const category of PATTERN_CATEGORIES) {
    for (const pattern of category.patterns) {
      const match = pattern.exec(text);
      if (match !== null) {
        const loc = offsetToLocation(text, match.index);
        findings.push({
          rule: "prompt-injection:text-scan",
          severity: category.severity,
          confidence: category.confidence,
          category: "PROMPT_INJECTION",
          message: `Potential ${category.label} detected: "${match[0].trim().slice(0, 60)}"`,
          location: loc,
        });
        // At most one finding per category
        break;
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const promptInjectionRule: ScanRule = {
  name: "prompt-injection",
  category: "PROMPT_INJECTION",
  defaultSeverity: "HIGH",
  check,
};
