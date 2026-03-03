/**
 * Nested include resolution for Agent Skills Standard.
 *
 * Resolves `includes` directives from SKILL.md frontmatter, supporting:
 * - Relative paths (./file.md, ../sibling/file.md)
 * - Recursive includes (up to configurable depth)
 * - Diamond deduplication (visited set)
 * - Security boundary enforcement (paths must stay within skillsRoot)
 */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";
import type { IncludeResolutionOptions, ResolvedInclude } from "./types.js";

const DEFAULT_MAX_DEPTH = 3;

/**
 * Resolves include directives from a skill's frontmatter.
 *
 * Algorithm:
 * 1. Resolve skillsRoot once via realpath for security boundary checks
 * 2. For each include path, resolve relative to skillDir
 * 3. Follow symlinks via realpath, validate within skillsRoot boundary
 * 4. Skip already-visited paths (diamond dedup, cycle protection)
 * 5. Read file content, check for nested includes, recurse if found
 * 6. Return ordered list of resolved includes
 */
export async function resolveIncludes(
  includes: readonly string[],
  skillDir: string,
  options: IncludeResolutionOptions,
): Promise<Result<readonly ResolvedInclude[], KoiError>> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const visited = new Set<string>();

  // Add the calling skill's SKILL.md to visited to prevent self-inclusion.
  // This prevents cycles where an included file references back to the caller.
  try {
    const selfReal = await realpath(resolve(skillDir, "SKILL.md"));
    visited.add(selfReal);
  } catch {
    // If current file can't be resolved, proceed without self-exclusion
  }

  // Resolve skillsRoot once — avoids redundant realpath calls per include path
  let realRoot: string; // let: assigned in try, used across all recursive calls
  try {
    realRoot = await realpath(resolve(options.skillsRoot));
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Skills root directory not found: ${options.skillsRoot}`,
        retryable: false,
        cause,
        context: { skillsRoot: options.skillsRoot },
      },
    };
  }

  return resolveRecursive(includes, skillDir, realRoot, visited, maxDepth);
}

// ---------------------------------------------------------------------------
// Single-path resolution
// ---------------------------------------------------------------------------

/** Resolves one include path: realpath → boundary check → dedup → read. */
async function resolveOnePath(
  includePath: string,
  skillDir: string,
  realRoot: string,
  visited: Set<string>,
): Promise<Result<ResolvedInclude | undefined, KoiError>> {
  const absolutePath = resolve(skillDir, includePath);

  // Follow symlinks and get canonical path
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
        message: `Include path escapes skills root: ${includePath} resolves to ${realPath}, which is outside ${realRoot}. Only relative paths within the skills directory are allowed.`,
        retryable: false,
        context: { errorKind: "INCLUDE_PATH_VIOLATION", includePath, realPath, realRoot },
      },
    };
  }

  // Diamond dedup / cycle protection: skip already-visited paths
  if (visited.has(realPath)) {
    return { ok: true, value: undefined };
  }
  visited.add(realPath);

  // Read file content
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
        context: { errorKind: "INCLUDE_NOT_FOUND", realPath },
      },
    };
  }

  return { ok: true, value: { path: realPath, content } };
}

// ---------------------------------------------------------------------------
// Recursive resolution
// ---------------------------------------------------------------------------

/** Resolves all includes sequentially, recursing into nested includes. */
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
        message: `Include depth exceeded maximum. Check for deep nesting in includes directives.`,
        retryable: false,
        context: { errorKind: "INCLUDE_DEPTH_EXCEEDED" },
      },
    };
  }

  const results: ResolvedInclude[] = [];

  for (const includePath of includes) {
    const oneResult = await resolveOnePath(includePath, skillDir, realRoot, visited);
    if (!oneResult.ok) return oneResult;
    if (oneResult.value === undefined) continue; // deduped — already visited

    results.push(oneResult.value);

    // Recurse into nested includes from the resolved file's frontmatter
    const nestedIncludes = extractIncludes(oneResult.value.content);
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

// ---------------------------------------------------------------------------
// Frontmatter extraction (lightweight, no full validation)
// ---------------------------------------------------------------------------

/** Type guard: narrows unknown[] to readonly string[]. */
function isStringArray(value: readonly unknown[]): value is readonly string[] {
  return value.every((item) => typeof item === "string");
}

/**
 * Extracts `includes` from YAML frontmatter without full validation.
 * Lightweight extraction — only parses frontmatter to find includes list.
 */
function extractIncludes(content: string): readonly string[] {
  const text = content.replace(/\r\n/g, "\n");

  const openIdx = text.indexOf("---");
  if (openIdx !== 0 && text.substring(0, openIdx).trim() !== "") {
    return [];
  }

  const afterOpen = openIdx + 3;
  const closeIdx = text.indexOf("\n---", afterOpen);
  if (closeIdx === -1) {
    return [];
  }

  const yamlStr = text.substring(afterOpen, closeIdx).trim();
  try {
    const parsed: unknown = Bun.YAML.parse(yamlStr);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return [];
    }
    // Narrowed to object by the guard above; satisfies isn't applicable to unknown
    const record = parsed as Readonly<Record<string, unknown>>;
    const includes = record.includes;
    if (Array.isArray(includes) && isStringArray(includes)) {
      return includes;
    }
  } catch {
    // Not valid YAML frontmatter — no includes to extract
  }
  return [];
}
