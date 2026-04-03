/**
 * Markdown frontmatter parser — splits YAML header from Markdown body.
 *
 * Uses the `yaml` npm package for portable YAML parsing (works in both Bun and Node).
 */

import type { KoiError, Result } from "@koi/core";
import { parse as parseYaml } from "yaml";

/** Parsed frontmatter result. */
export interface FrontmatterResult {
  readonly meta: Readonly<Record<string, unknown>>;
  readonly body: string;
}

// Matches: opening ---, YAML content, closing ---, optional body
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

/**
 * Parse Markdown content with optional YAML frontmatter.
 *
 * - Valid frontmatter → `{ meta: parsed YAML, body: remaining content }`
 * - No frontmatter delimiters → `{ meta: {}, body: raw content }`
 * - Malformed YAML in frontmatter → error result
 */
export function parseFrontmatter(content: string): Result<FrontmatterResult, KoiError> {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { ok: true, value: { meta: {}, body: content.trim() } };
  }

  const yamlStr = match[1] ?? "";
  const body = (match[2] ?? "").trim();

  try {
    const parsed: unknown = parseYaml(yamlStr);
    if (parsed === null || parsed === undefined) {
      return { ok: true, value: { meta: {}, body } };
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Frontmatter must be a YAML mapping (key: value pairs), not a scalar or array",
          retryable: false,
        },
      };
    }
    return { ok: true, value: { meta: parsed as Readonly<Record<string, unknown>>, body } };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Malformed YAML in frontmatter: ${msg}`,
        retryable: false,
      },
    };
  }
}
