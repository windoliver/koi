/**
 * Budget-aware skill description formatting for the SkillTool tool description.
 *
 * Three-phase approach:
 * 1. Full descriptions for all skills
 * 2. Bundled keep full; non-bundled truncated
 * 3. Names only, with overflow indicator
 */

import type { SkillMeta } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum total characters for the skill listing section. */
export const MAX_DESCRIPTION_CHARS = 8000;

/** Maximum per-skill description length in phase 2 truncation. */
const MAX_ENTRY_DESC_CHARS = 250;

const HEADER = "Available skills (invoke by name):";
const OVERFLOW_SUFFIX = "... and %d more";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatFull(skill: SkillMeta): string {
  return `- ${skill.name}: ${skill.description}`;
}

function formatTruncated(skill: SkillMeta): string {
  const desc =
    skill.description.length > MAX_ENTRY_DESC_CHARS
      ? `${skill.description.slice(0, MAX_ENTRY_DESC_CHARS - 3)}...`
      : skill.description;
  return `- ${skill.name}: ${desc}`;
}

function formatNameOnly(skill: SkillMeta): string {
  return `- ${skill.name}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Formats a list of skill metadata into a budget-constrained description string.
 *
 * Skills are listed alphabetically. Bundled skills are never truncated in
 * phase 2. Returns an empty string when no skills are provided.
 */
export function formatSkillDescription(
  skills: readonly SkillMeta[],
  budget: number = MAX_DESCRIPTION_CHARS,
): string {
  if (skills.length === 0) return "";

  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));

  // Phase 1: full descriptions
  const fullLines = sorted.map(formatFull);
  const phase1 = `${HEADER}\n${fullLines.join("\n")}`;
  if (phase1.length <= budget) return phase1;

  // Phase 2: bundled keep full, non-bundled truncated
  const phase2Lines = sorted.map((s) =>
    s.source === "bundled" ? formatFull(s) : formatTruncated(s),
  );
  const phase2 = `${HEADER}\n${phase2Lines.join("\n")}`;
  if (phase2.length <= budget) return phase2;

  // Phase 3: names only, with overflow
  const nameLines = sorted.map(formatNameOnly);
  const headerLen = HEADER.length + 1; // +1 for newline after header
  let included = 0;
  let runningLen = headerLen;
  for (const line of nameLines) {
    const lineLen = line.length + 1;
    if (runningLen + lineLen > budget) break;
    runningLen += lineLen;
    included++;
  }

  // Ensure at least one skill is shown
  if (included === 0) included = 1;

  const shownLines = nameLines.slice(0, included);
  const remaining = sorted.length - included;
  if (remaining > 0) {
    shownLines.push(OVERFLOW_SUFFIX.replace("%d", String(remaining)));
  }

  return `${HEADER}\n${shownLines.join("\n")}`;
}
