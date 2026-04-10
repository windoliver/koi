/**
 * Regex-based learning extraction — identifies reusable learnings from tool output.
 *
 * Two extraction mechanisms:
 * 1. Marker-based: Agents opt-in with `[LEARNING:category] content` markers
 * 2. Heuristic patterns: Keyword-based extraction for implicit learnings
 *
 * Ported from v1 middleware-collective-memory with v2 type mapping.
 */

import type { CollectiveMemoryCategory, MemoryType } from "@koi/core";
import type { ExtractionCandidate, LearningExtractor } from "./types.js";

// ---------------------------------------------------------------------------
// Category → MemoryType mapping
// ---------------------------------------------------------------------------

const CATEGORY_TO_MEMORY_TYPE: Readonly<Record<CollectiveMemoryCategory, MemoryType>> = {
  gotcha: "feedback",
  correction: "feedback",
  heuristic: "reference",
  pattern: "reference",
  preference: "user",
  context: "project",
};

export function mapCategoryToMemoryType(category: CollectiveMemoryCategory): MemoryType {
  return CATEGORY_TO_MEMORY_TYPE[category];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKER_REGEX = /\[LEARNING:(\w+)]\s*(.+)/g;

const VALID_CATEGORIES = new Set<string>([
  "gotcha",
  "heuristic",
  "preference",
  "correction",
  "pattern",
  "context",
]);

/** Maximum content length per entry (characters). Longer entries are truncated. */
const MAX_ENTRY_LENGTH = 500;

function truncate(text: string): string {
  return text.length > MAX_ENTRY_LENGTH ? text.slice(0, MAX_ENTRY_LENGTH) : text;
}

// ---------------------------------------------------------------------------
// Marker-based extraction
// ---------------------------------------------------------------------------

function extractMarkers(output: string): readonly ExtractionCandidate[] {
  const results: ExtractionCandidate[] = [];
  MARKER_REGEX.lastIndex = 0;

  // let justified: regex exec loop requires mutable match variable
  let match = MARKER_REGEX.exec(output);
  while (match !== null) {
    const rawCategory = match[1]?.toLowerCase();
    const content = match[2]?.trim();
    if (rawCategory !== undefined && content !== undefined && content.length > 0) {
      const category: CollectiveMemoryCategory = VALID_CATEGORIES.has(rawCategory)
        ? (rawCategory as CollectiveMemoryCategory)
        : "context";
      results.push({
        content: truncate(content),
        memoryType: mapCategoryToMemoryType(category),
        category,
        confidence: 1.0,
      });
    }
    match = MARKER_REGEX.exec(output);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Heuristic-based extraction
// ---------------------------------------------------------------------------

interface HeuristicPattern {
  readonly regex: RegExp;
  readonly category: CollectiveMemoryCategory;
}

const HEURISTIC_PATTERNS: readonly HeuristicPattern[] = [
  {
    regex: /(?:mistake was|avoid|don'?t|gotcha|pitfall|watch out|be careful)[:\s]+(.+)/i,
    category: "gotcha",
  },
  {
    regex: /(?:actually|correction|not\s+\w+\s+but|turns out)[:\s]+(.+)/i,
    category: "correction",
  },
  {
    regex: /(?:next time|should always|better approach|best practice|pattern)[:\s]+(.+)/i,
    category: "pattern",
  },
  {
    regex: /(?:learned that|key insight|rule of thumb|important to|remember that)[:\s]+(.+)/i,
    category: "heuristic",
  },
];

function extractHeuristics(output: string): readonly ExtractionCandidate[] {
  const results: ExtractionCandidate[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    for (const pattern of HEURISTIC_PATTERNS) {
      const match = pattern.regex.exec(trimmed);
      if (match !== null) {
        const content = match[1]?.trim();
        if (content !== undefined && content.length > 0) {
          results.push({
            content: truncate(content),
            memoryType: mapCategoryToMemoryType(pattern.category),
            category: pattern.category,
            confidence: 0.7,
          });
        }
        break; // First pattern wins per line
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Combined extractor
// ---------------------------------------------------------------------------

/**
 * Deduplicates candidates by content (case-insensitive).
 * Higher confidence wins on collision.
 */
function deduplicateCandidates(
  candidates: readonly ExtractionCandidate[],
): readonly ExtractionCandidate[] {
  const seen = new Map<string, ExtractionCandidate>();
  for (const candidate of candidates) {
    const key = candidate.content.toLowerCase();
    const existing = seen.get(key);
    if (existing === undefined || candidate.confidence > existing.confidence) {
      seen.set(key, candidate);
    }
  }
  return [...seen.values()];
}

/**
 * Creates the default learning extractor.
 *
 * Combines marker-based and heuristic extraction, deduplicates,
 * and sorts by confidence (highest first).
 */
export function createDefaultExtractor(): LearningExtractor {
  return {
    extract(output: string): readonly ExtractionCandidate[] {
      const markers = extractMarkers(output);
      const heuristics = extractHeuristics(output);
      const combined = [...markers, ...heuristics];
      const deduped = deduplicateCandidates(combined);
      return [...deduped].sort((a, b) => b.confidence - a.confidence);
    },
  };
}
