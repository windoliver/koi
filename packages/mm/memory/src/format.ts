/**
 * Memory formatting — converts scored memories into a system prompt
 * section with optional trusting-recall note. Pure functions, zero I/O.
 */

import type { ScoredMemory } from "./salience.js";

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/** Options for formatting recalled memories into a prompt section. */
export interface FormatOptions {
  /** Section heading text. Default: "Memory". */
  readonly sectionTitle?: string | undefined;
  /** Append salience scores after headings (debug mode). Default: false. */
  readonly includeScores?: boolean | undefined;
  /** Include a note advising the model to verify stale references. Default: true. */
  readonly trustingRecallNote?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SECTION_TITLE = "Memory";

const TRUSTING_RECALL_NOTE =
  "> Memories may be stale. Verify file paths and function names exist before recommending.";

// ---------------------------------------------------------------------------
// Formatting functions
// ---------------------------------------------------------------------------

/**
 * Formats a single scored memory as a Markdown block.
 *
 * Output:
 * ```
 * ### {name} ({type}) [score: 0.87]
 * {content}
 * ```
 *
 * The `[score: ...]` suffix is only included when `includeScore` is true.
 */
export function formatSingleMemory(scored: ScoredMemory, includeScore?: boolean): string {
  const heading = `### ${scored.memory.record.name} (${scored.memory.record.type})`;
  const scoreSuffix = includeScore === true ? ` [score: ${scored.salienceScore.toFixed(2)}]` : "";
  return `${heading}${scoreSuffix}\n${scored.memory.record.content}`;
}

/**
 * Formats an array of scored memories into a complete system prompt section.
 *
 * Returns an empty string if `memories` is empty.
 * Groups memories by type in the order they appear (already sorted by salience).
 * Includes a trusting-recall note by default (CC's TRUSTING_RECALL_SECTION pattern).
 */
export function formatMemorySection(
  memories: readonly ScoredMemory[],
  options?: FormatOptions,
): string {
  if (memories.length === 0) return "";

  const title = options?.sectionTitle ?? DEFAULT_SECTION_TITLE;
  const includeScores = options?.includeScores === true;
  const trustingRecall = options?.trustingRecallNote !== false;

  const parts: string[] = [`## ${title}\n`];

  if (trustingRecall) {
    parts.push(`${TRUSTING_RECALL_NOTE}\n`);
  }

  const blocks = memories.map((m) => formatSingleMemory(m, includeScores));
  parts.push(blocks.join("\n\n"));

  return parts.join("\n");
}
