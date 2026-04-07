/**
 * SKILL.md parser — splits YAML frontmatter from the markdown body.
 *
 * Format:
 *   ---
 *   name: my-skill
 *   description: Does X.
 *   ---
 *
 *   # Skill body markdown...
 *
 * Uses Bun.YAML.parse() — no external YAML dependency.
 */

import type { KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedSkillMd {
  /** Raw YAML frontmatter values (unknown — validated separately). */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Markdown body text (without the frontmatter block). */
  readonly body: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRONTMATTER_OPEN = "---";
const FRONTMATTER_CLOSE = "\n---";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses a SKILL.md file content into frontmatter + body.
 *
 * Returns VALIDATION error if:
 * - No opening `---` delimiter found
 * - No closing `---` delimiter found
 * - YAML parse fails
 * - Frontmatter is not a plain object
 */
export function parseSkillMd(content: string, filePath?: string): Result<ParsedSkillMd, KoiError> {
  const text = content.replace(/\r\n/g, "\n");
  const location = filePath !== undefined ? ` in ${filePath}` : "";

  // Must start with ---  (allow optional leading whitespace trimmed by normalize)
  if (!text.startsWith(FRONTMATTER_OPEN)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Missing YAML frontmatter opening delimiter${location}. SKILL.md must start with ---.`,
        retryable: false,
        context: { errorKind: "MISSING_FRONTMATTER" },
      },
    };
  }

  const afterOpen = FRONTMATTER_OPEN.length;
  const closeIdx = text.indexOf(FRONTMATTER_CLOSE, afterOpen);

  if (closeIdx === -1) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Missing YAML frontmatter closing delimiter${location}. Add --- on its own line after the frontmatter.`,
        retryable: false,
        context: { errorKind: "MISSING_FRONTMATTER_CLOSE" },
      },
    };
  }

  const yamlStr = text.substring(afterOpen, closeIdx).trim();

  // Parse YAML frontmatter
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(yamlStr);
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Failed to parse YAML frontmatter${location}: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
        cause,
        context: { errorKind: "INVALID_YAML" },
      },
    };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `YAML frontmatter must be a mapping (key: value pairs)${location}, got ${Array.isArray(raw) ? "array" : typeof raw}.`,
        retryable: false,
        context: { errorKind: "INVALID_FRONTMATTER_TYPE" },
      },
    };
  }

  const frontmatter = raw as Readonly<Record<string, unknown>>;
  // Body starts after the closing --- line
  const body = text.substring(closeIdx + FRONTMATTER_CLOSE.length).replace(/^\n/, "");

  return { ok: true, value: { frontmatter, body } };
}
