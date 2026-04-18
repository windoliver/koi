/**
 * Plan-file markdown serializer/parser and slug sanitizer.
 *
 * Wire format:
 *
 * ```markdown
 * ---
 * generated: 2026-04-17T10:23:00.000Z
 * sessionId: <id>
 * epoch: 1
 * turnIndex: 7
 * ---
 * # Plan
 *
 * - [ ] First item
 * - [in_progress] Second item
 * - [x] Third item
 * ```
 *
 * Frontmatter is parsed with a fixed-key reader, not a YAML parser —
 * unknown keys are tolerated and discarded. Item content escaping
 * matches `@koi/middleware-planning`'s `escapePlanItem` so a round-trip
 * through this format never produces an item the planning middleware
 * would reject.
 */

import type { PlanItem, PlanStatus } from "./types.js";

const STATUS_TO_BOX: Record<PlanStatus, string> = {
  pending: "[ ]",
  in_progress: "[in_progress]",
  completed: "[x]",
};

const BOX_TO_STATUS: Record<string, PlanStatus> = {
  "[ ]": "pending",
  "[in_progress]": "in_progress",
  "[x]": "completed",
  "[X]": "completed",
};

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 48;
const MIN_SLUG_LENGTH = 1;

export interface PlanFileMetadata {
  readonly generated: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly turnIndex: number;
}

/** Escape model-authored content to match planning middleware's runtime escaping. */
function escapePlanItem(raw: string): string {
  return raw.replace(/```/g, "'''").replace(/\r?\n/g, " ");
}

export function generatePlanMarkdown(items: readonly PlanItem[], meta: PlanFileMetadata): string {
  const frontmatter = [
    "---",
    `generated: ${meta.generated}`,
    `sessionId: ${meta.sessionId}`,
    `epoch: ${String(meta.epoch)}`,
    `turnIndex: ${String(meta.turnIndex)}`,
    "---",
  ].join("\n");

  const body = items
    .map((item) => `- ${STATUS_TO_BOX[item.status]} ${escapePlanItem(item.content)}`)
    .join("\n");

  return `${frontmatter}\n# Plan\n\n${body}\n`;
}

type ParseResult =
  | { readonly ok: true; readonly items: readonly PlanItem[] }
  | { readonly ok: false; readonly error: string };

/** Parse a plan markdown file. Tolerates missing/extra frontmatter; rejects malformed item lines. */
export function parsePlanMarkdown(source: string): ParseResult {
  const lines = source.split(/\r?\n/);
  let cursor = 0;

  // Skip optional frontmatter — fixed-key reader, no YAML eval.
  if (lines[cursor] === "---") {
    cursor++;
    while (cursor < lines.length && lines[cursor] !== "---") {
      cursor++;
    }
    if (cursor >= lines.length) {
      return { ok: false, error: "frontmatter not closed" };
    }
    cursor++; // consume closing ---
  }

  const items: PlanItem[] = [];
  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor] ?? "";
    if (line.trim().length === 0) continue;
    if (line.startsWith("#")) continue; // headings ignored
    if (!line.startsWith("- ")) {
      return { ok: false, error: `unexpected line ${String(cursor + 1)}: not a list item` };
    }

    const rest = line.slice(2).trimStart();
    const match = rest.match(/^(\[[^\]]*\])\s+(.*)$/);
    if (!match) {
      return { ok: false, error: `line ${String(cursor + 1)}: missing status box` };
    }

    const box = match[1] ?? "";
    const content = (match[2] ?? "").trim();
    const status = BOX_TO_STATUS[box];
    if (status === undefined) {
      return { ok: false, error: `line ${String(cursor + 1)}: unknown status "${box}"` };
    }
    if (content.length === 0) {
      return { ok: false, error: `line ${String(cursor + 1)}: empty content` };
    }
    items.push({ content, status });
  }

  return { ok: true, items };
}

/**
 * Validate a slug. Returns the slug when valid, or an error message.
 *
 * Rules: `[a-z0-9-]`, 1–48 chars, no leading/trailing dash, no double dashes.
 * Path separators, `..`, NUL bytes, Unicode tricks are all rejected by the
 * regex before they can reach the filename.
 */
export function validateSlug(
  raw: string,
): { readonly ok: true; readonly slug: string } | { readonly ok: false; readonly error: string } {
  if (raw.length < MIN_SLUG_LENGTH || raw.length > MAX_SLUG_LENGTH) {
    return {
      ok: false,
      error: `slug length must be ${String(MIN_SLUG_LENGTH)}-${String(MAX_SLUG_LENGTH)}`,
    };
  }
  if (!SLUG_PATTERN.test(raw)) {
    return { ok: false, error: "slug must match /^[a-z0-9]+(-[a-z0-9]+)*$/" };
  }
  return { ok: true, slug: raw };
}

const SLUG_WORDS: readonly string[] = [
  "amber",
  "brisk",
  "calm",
  "dawn",
  "ember",
  "frost",
  "gale",
  "hush",
  "iris",
  "jade",
  "kelp",
  "loam",
  "mist",
  "nest",
  "opal",
  "pine",
  "quill",
  "river",
  "sage",
  "tide",
  "vale",
  "willow",
  "yarn",
  "zest",
];

/** Generate a deterministic-friendly two-word slug. */
export function generateSlug(rand: () => number = Math.random): string {
  const a = SLUG_WORDS[Math.floor(rand() * SLUG_WORDS.length)] ?? "plan";
  const b = SLUG_WORDS[Math.floor(rand() * SLUG_WORDS.length)] ?? "draft";
  return `${a}-${b}`;
}

/** Format a Date as `YYYYMMDD-HHmmss` in UTC for filename prefixes. */
export function generateTimestamp(date: Date): string {
  const yyyy = date.getUTCFullYear().toString().padStart(4, "0");
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = date.getUTCDate().toString().padStart(2, "0");
  const hh = date.getUTCHours().toString().padStart(2, "0");
  const mi = date.getUTCMinutes().toString().padStart(2, "0");
  const ss = date.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}
