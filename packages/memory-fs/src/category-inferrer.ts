/**
 * Keyword-based category inferrer — pure heuristic, no LLM cost.
 *
 * Scans fact content for category-indicating keywords and returns the
 * first matching category. Falls back to `"context"` when no rule matches.
 */

import type { CategoryInferrer } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CategoryRule {
  readonly category: string;
  readonly pattern: RegExp;
}

export interface KeywordCategoryInferrerOptions {
  /** Additional rules prepended to defaults (higher priority). */
  readonly additionalRules?: readonly CategoryRule[] | undefined;
  /** Override the default fallback category (`"context"`). */
  readonly fallback?: string | undefined;
}

// ---------------------------------------------------------------------------
// Default rules — ordered by specificity (most specific first)
// ---------------------------------------------------------------------------

const DEFAULT_RULES: readonly CategoryRule[] = [
  {
    category: "decision",
    pattern: /\b(?:chose|chosen|decided|picked|went\s+with|settled\s+on)\b/i,
  },
  {
    category: "error-pattern",
    pattern: /\b(?:error|failed|failure|bug|crash|exception|broke|broken)\b/i,
  },
  {
    category: "preference",
    pattern: /\b(?:prefers?|likes?|always\s+uses?|favou?rite|dislikes?)\b/i,
  },
  {
    category: "correction",
    pattern: /\b(?:corrected?|corrections?|fixed|wrong|mistake|shouldn'?t\s+have)\b/i,
  },
  {
    category: "milestone",
    pattern: /\b(?:completed?|finished|shipped|launched|deployed|released|milestone|achieved)\b/i,
  },
  {
    category: "relationship",
    pattern: /\b(?:works?\s+(?:with|for|at|on)|reports?\s+to|manages?|owns?|maintains?|team)\b/i,
  },
];

const DEFAULT_FALLBACK = "context";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createKeywordCategoryInferrer(
  options?: KeywordCategoryInferrerOptions,
): CategoryInferrer {
  const additional = options?.additionalRules ?? [];
  const rules: readonly CategoryRule[] =
    additional.length > 0 ? [...additional, ...DEFAULT_RULES] : DEFAULT_RULES;
  const fallback = options?.fallback ?? DEFAULT_FALLBACK;

  return (content: string): string => {
    for (const rule of rules) {
      rule.pattern.lastIndex = 0; // guard against /g flag on user-supplied patterns
      if (rule.pattern.test(content)) {
        return rule.category;
      }
    }
    return fallback;
  };
}
