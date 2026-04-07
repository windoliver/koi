/**
 * Nested include resolution for Agent Skills Standard.
 *
 * Resolves `includes` directives from SKILL.md frontmatter, supporting:
 * - Relative paths (./file.md, ../sibling/file.md)
 * - Recursive includes up to MAX_DEPTH
 * - Diamond deduplication (visited set)
 * - Security boundary enforcement (paths must stay within skillsRoot)
 *
 * Decision 14C: sequential resolution (not parallel) to preserve include order
 * and simplify error propagation.
 */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";

const MAX_DEPTH = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedInclude {
  readonly path: string;
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves include directives from a skill's frontmatter.
 *
 * @param includes  - Array of relative paths from the frontmatter `includes` key.
 * @param skillDir  - Absolute path to the skill directory (contains SKILL.md).
 * @param skillsRoot - Absolute path to the skills root (security boundary).
 */
export async function resolveIncludes(
  includes: readonly string[],
  skillDir: string,
  skillsRoot: string,
): Promise<Result<readonly ResolvedInclude[], KoiError>> {
  const visited = new Set<string>();

  // Add the calling skill's SKILL.md to visited to prevent self-inclusion.
  try {
    const selfReal = await realpath(resolve(skillDir, "SKILL.md"));
    visited.add(selfReal);
  } catch {
    // If current file can't be resolved, proceed without self-exclusion
  }

  // Resolve skillsRoot once — avoids redundant realpath calls per include
  let realRoot: string; // let: assigned in try, used across all recursive calls
  try {
    realRoot = await realpath(resolve(skillsRoot));
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Skills root directory not found: ${skillsRoot}`,
        retryable: false,
        cause,
        context: { skillsRoot },
      },
    };
  }

  return resolveRecursive(includes, skillDir, realRoot, visited, MAX_DEPTH);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function resolveOnePath(
  includePath: string,
  skillDir: string,
  realRoot: string,
  visited: Set<string>,
): Promise<Result<ResolvedInclude | undefined, KoiError>> {
  const absolutePath = resolve(skillDir, includePath);

  let realPath: string; // let: assigned in try, used after catch
  try {
    realPath = await realpath(absolutePath);
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Included file not found: ${includePath} (resolved to ${absolutePath}). Check the path in your includes directive.`,
        retryable: false,
        cause,
        context: { errorKind: "INCLUDE_NOT_FOUND", includePath, absolutePath },
      },
    };
  }

  // Security boundary: resolved path must stay within skillsRoot
  if (!realPath.startsWith(`${realRoot}/`) && realPath !== realRoot) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Include path escapes skills root: ${includePath} resolves to ${realPath}, which is outside ${realRoot}. Only paths within the skills directory are allowed.`,
        retryable: false,
        context: { errorKind: "INCLUDE_PATH_VIOLATION", includePath, realPath, realRoot },
      },
    };
  }

  // Diamond dedup / cycle protection
  if (visited.has(realPath)) {
    return { ok: true, value: undefined }; // already visited — skip
  }
  visited.add(realPath);

  let content: string; // let: assigned in try, used after catch
  try {
    content = await Bun.file(realPath).text();
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Failed to read included file: ${realPath}`,
        retryable: false,
        cause,
        context: { errorKind: "INCLUDE_READ_FAILED", realPath },
      },
    };
  }

  return { ok: true, value: { path: realPath, content } };
}

async function resolveRecursive(
  includes: readonly string[],
  skillDir: string,
  realRoot: string,
  visited: Set<string>,
  remainingDepth: number,
): Promise<Result<readonly ResolvedInclude[], KoiError>> {
  if (remainingDepth <= 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Include depth exceeded maximum (${MAX_DEPTH}). Check for deep nesting in your includes directives.`,
        retryable: false,
        context: { errorKind: "INCLUDE_DEPTH_EXCEEDED", maxDepth: MAX_DEPTH },
      },
    };
  }

  const results: ResolvedInclude[] = [];

  for (const includePath of includes) {
    const oneResult = await resolveOnePath(includePath, skillDir, realRoot, visited);
    if (!oneResult.ok) return oneResult;
    if (oneResult.value === undefined) continue; // deduped

    results.push(oneResult.value);

    // Recurse into nested includes
    const nestedIncludes = extractIncludesFromContent(oneResult.value.content);
    if (nestedIncludes.length > 0) {
      const nestedDir = resolve(oneResult.value.path, "..");
      const nestedResult = await resolveRecursive(
        nestedIncludes,
        nestedDir,
        realRoot,
        visited,
        remainingDepth - 1,
      );
      if (!nestedResult.ok) return nestedResult;
      for (const nested of nestedResult.value) {
        results.push(nested);
      }
    }
  }

  return { ok: true, value: results };
}

/**
 * Extracts `includes` from YAML frontmatter without full validation.
 * Lightweight — only parses frontmatter to find the includes list.
 */
function extractIncludesFromContent(content: string): readonly string[] {
  const text = content.replace(/\r\n/g, "\n");
  if (!text.startsWith("---")) return [];

  const closeIdx = text.indexOf("\n---", 3);
  if (closeIdx === -1) return [];

  const yamlStr = text.substring(3, closeIdx).trim();
  try {
    const parsed: unknown = Bun.YAML.parse(yamlStr);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return [];
    }
    const record = parsed as Readonly<Record<string, unknown>>;
    const includes = record.includes;
    if (Array.isArray(includes) && includes.every((i) => typeof i === "string")) {
      return includes as readonly string[];
    }
  } catch {
    // Not valid YAML — no includes
  }
  return [];
}
