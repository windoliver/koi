/**
 * SKILL.md parser — extracts YAML frontmatter and markdown body.
 *
 * Custom implementation (~30 lines) using String.indexOf() for `---` delimiters.
 * YAML parsed by Bun.YAML.parse(). No external dependencies.
 */

import type { KoiError, Result } from "@koi/core";

/** Type guard: narrows unknown to a record after typeof/null/array checks. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parsed SKILL.md output before validation. */
export interface ParsedSkillMd {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
}

/**
 * Parses a SKILL.md file content into frontmatter (raw object) and body (markdown string).
 *
 * Expected format:
 * ```
 * ---
 * name: my-skill
 * description: Does things
 * ---
 * # Markdown body here
 * ```
 */
export function parseSkillMd(raw: string): Result<ParsedSkillMd, KoiError> {
  // Normalize CRLF → LF
  const text = raw.replace(/\r\n/g, "\n");

  // Find opening ---
  const openIdx = text.indexOf("---");
  if (openIdx !== 0 && text.substring(0, openIdx).trim() !== "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "SKILL.md must start with YAML frontmatter delimited by ---",
        retryable: false,
      },
    };
  }

  // Find closing ---
  const afterOpen = openIdx + 3;
  const closeIdx = text.indexOf("\n---", afterOpen);
  if (closeIdx === -1) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "SKILL.md frontmatter is missing closing --- delimiter",
        retryable: false,
      },
    };
  }

  const yamlStr = text.substring(afterOpen, closeIdx).trim();
  const body = text.substring(closeIdx + 4).trim();

  // Parse YAML frontmatter
  let frontmatter: unknown;
  try {
    frontmatter = Bun.YAML.parse(yamlStr);
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `SKILL.md frontmatter YAML parse error: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
        cause,
      },
    };
  }

  if (!isRecord(frontmatter)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "SKILL.md frontmatter must be a YAML mapping (object), not a scalar or array",
        retryable: false,
      },
    };
  }

  return {
    ok: true,
    value: { frontmatter, body },
  };
}
