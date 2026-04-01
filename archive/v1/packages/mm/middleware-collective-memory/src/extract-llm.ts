/**
 * LLM-based learning extraction — post-session structured extraction
 * using a cheap model (Haiku-class).
 *
 * Complements the regex-based real-time extraction with a more reliable
 * LLM pass that runs once after a worker session finishes.
 */

import type { CollectiveMemoryCategory } from "@koi/core";
import type { LearningCandidate } from "./types.js";

const VALID_CATEGORIES = new Set<CollectiveMemoryCategory>([
  "gotcha",
  "heuristic",
  "preference",
  "correction",
  "pattern",
  "context",
]);

/** Type guard for CollectiveMemoryCategory. */
function isValidCategory(value: string): value is CollectiveMemoryCategory {
  return (VALID_CATEGORIES as Set<string>).has(value);
}

/** Maximum content length per extracted entry (characters). */
const MAX_ENTRY_LENGTH = 500;

/** Default confidence for LLM-extracted entries. */
const LLM_CONFIDENCE = 0.9;

/**
 * Builds the extraction prompt from accumulated worker outputs.
 * The prompt asks the model to produce a JSON array of learnings.
 */
export function createExtractionPrompt(outputs: readonly string[]): string {
  const combined = outputs.join("\n---\n");
  return `You are analyzing outputs from an AI worker agent session. Extract reusable learnings that would help future workers of the same type.

For each learning, output a JSON array:
[{ "content": "...", "category": "gotcha|heuristic|preference|correction|pattern|context" }]

Categories:
- gotcha: pitfalls, common mistakes to avoid
- heuristic: rules of thumb, general guidelines
- pattern: reusable approaches or techniques
- correction: corrected misconceptions
- preference: style/approach preferences discovered
- context: general domain knowledge

Rules:
- Only extract genuinely reusable insights, not task-specific details
- Keep each entry concise (1-2 sentences)
- Prefer actionable learnings over observations
- Return [] if no learnings found
- Output ONLY the JSON array, no other text

Worker outputs:
${combined}`;
}

/**
 * Parses the LLM extraction response into validated candidates.
 * Returns empty array on malformed/invalid response.
 */
export function parseExtractionResponse(response: string): readonly LearningCandidate[] {
  try {
    // Extract JSON array from response — models may wrap in fences or add surrounding text
    const arrayMatch = response.match(/\[[\s\S]*\]/);
    if (arrayMatch === null) return [];

    const parsed: unknown = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const results: LearningCandidate[] = [];
    for (const raw of parsed) {
      if (raw === null || typeof raw !== "object") continue;

      const entry = raw as Record<string, unknown>;
      const content = typeof entry.content === "string" ? entry.content.trim() : "";
      if (content.length === 0) continue;

      const rawCategory = typeof entry.category === "string" ? entry.category.toLowerCase() : "";
      const category: CollectiveMemoryCategory = isValidCategory(rawCategory)
        ? rawCategory
        : "context";

      results.push({
        content: content.length > MAX_ENTRY_LENGTH ? content.slice(0, MAX_ENTRY_LENGTH) : content,
        category,
        confidence: LLM_CONFIDENCE,
      });
    }

    return results;
  } catch (_e: unknown) {
    return [];
  }
}
