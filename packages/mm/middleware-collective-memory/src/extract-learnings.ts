/**
 * Learning extraction — identifies reusable learnings from worker output.
 *
 * Two extraction mechanisms:
 * 1. Marker-based: Workers opt-in with `[LEARNING:category] content` markers
 * 2. Heuristic patterns: Keyword-based extraction for implicit learnings
 */

import type { CollectiveMemoryCategory } from "@koi/core";
import type { LearningCandidate, LearningExtractor } from "./types.js";

// ---------------------------------------------------------------------------
// Marker-based extraction
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

function extractMarkers(output: string): readonly LearningCandidate[] {
  const results: LearningCandidate[] = [];
  // Reset lastIndex for global regex
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
  // Gotchas / pitfalls
  {
    regex: /(?:mistake was|avoid|don'?t|gotcha|pitfall|watch out|be careful)[:\s]+(.+)/i,
    category: "gotcha",
  },
  // Corrections
  { regex: /(?:actually|correction|not\s+\w+\s+but|turns out)[:\s]+(.+)/i, category: "correction" },
  // Patterns
  {
    regex: /(?:next time|should always|better approach|best practice|pattern)[:\s]+(.+)/i,
    category: "pattern",
  },
  // Heuristics / rules of thumb
  {
    regex: /(?:learned that|key insight|rule of thumb|important to|remember that)[:\s]+(.+)/i,
    category: "heuristic",
  },
];

function extractHeuristics(output: string): readonly LearningCandidate[] {
  const results: LearningCandidate[] = [];
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
 * Markers (confidence 1.0) take priority over heuristics.
 */
function deduplicateCandidates(
  candidates: readonly LearningCandidate[],
): readonly LearningCandidate[] {
  const seen = new Map<string, LearningCandidate>();
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
    extract(output: string): readonly LearningCandidate[] {
      const markers = extractMarkers(output);
      const heuristics = extractHeuristics(output);
      const combined = [...markers, ...heuristics];
      const deduped = deduplicateCandidates(combined);
      return [...deduped].sort((a, b) => b.confidence - a.confidence);
    },
  };
}
