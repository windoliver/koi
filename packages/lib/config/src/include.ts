/**
 * $include directive processing with cycle detection.
 *
 * Supports diamond-shaped include graphs (same file included via two paths).
 * Detects and rejects circular includes.
 */

import { dirname, resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { loadConfigFromString } from "./loader.js";
import { deepMerge } from "./merge.js";

/** Options for `processIncludes()`. */
export interface ProcessIncludesOptions {
  /** Environment variables for interpolation in included files. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Maximum include depth. Defaults to 5. */
  readonly maxDepth?: number | undefined;
}

const DEFAULT_MAX_DEPTH = 5;

/**
 * Recursively resolves `$include` directives in a parsed config object.
 *
 * - `$include` must be an array of relative file paths.
 * - Included files are merged left-to-right, then the parent overrides.
 * - Diamond includes (same file reached via multiple paths) are allowed.
 * - Circular includes are detected and return an error.
 *
 * @param parsed - The parsed config object (may contain `$include`).
 * @param parentDir - Directory of the file that contained `parsed`.
 * @param options - Env vars and max depth.
 */
export async function processIncludes(
  parsed: Readonly<Record<string, unknown>>,
  parentDir: string,
  options?: ProcessIncludesOptions,
): Promise<Result<Record<string, unknown>, KoiError>> {
  return processIncludesRecursive(
    parsed,
    parentDir,
    options?.env,
    options?.maxDepth ?? DEFAULT_MAX_DEPTH,
    0,
    new Set(),
  );
}

async function processIncludesRecursive(
  parsed: Readonly<Record<string, unknown>>,
  parentDir: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  maxDepth: number,
  currentDepth: number,
  ancestors: ReadonlySet<string>,
): Promise<Result<Record<string, unknown>, KoiError>> {
  const includeValue = parsed.$include;
  if (includeValue === undefined) {
    return { ok: true, value: parsed as Record<string, unknown> };
  }

  if (!Array.isArray(includeValue)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "$include must be an array of file paths",
        retryable: false,
        context: { parentDir },
      },
    };
  }

  if (currentDepth >= maxDepth) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `$include max depth exceeded (${maxDepth})`,
        retryable: false,
        context: { parentDir, maxDepth },
      },
    };
  }

  const includes = includeValue as readonly unknown[];
  let merged: Record<string, unknown> = {};

  for (const entry of includes) {
    if (typeof entry !== "string") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "$include entries must be strings",
          retryable: false,
          context: { parentDir, entry },
        },
      };
    }

    const includePath = resolve(parentDir, entry);

    // Cycle detection: check ancestors (not visited — diamonds are OK)
    if (ancestors.has(includePath)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Circular $include detected: ${includePath}`,
          retryable: false,
          context: { parentDir, includePath },
        },
      };
    }

    // Read + parse the included file
    let content: string;
    try {
      content = await Bun.file(includePath).text();
    } catch (cause: unknown) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Included config file not found: ${includePath}`,
          retryable: false,
          context: { parentDir, includePath },
          cause,
        },
      };
    }

    const parseResult = loadConfigFromString(content, includePath, { env });
    if (!parseResult.ok) {
      return parseResult;
    }

    // Recurse into included file's own $include directives
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(includePath);

    const resolved = await processIncludesRecursive(
      parseResult.value,
      dirname(includePath),
      env,
      maxDepth,
      currentDepth + 1,
      nextAncestors,
    );

    if (!resolved.ok) {
      return resolved;
    }

    merged = deepMerge(merged, resolved.value);
  }

  // Parent overrides included values; strip $include key
  const { $include: _, ...parentFields } = parsed;
  return { ok: true, value: deepMerge(merged, parentFields as Record<string, unknown>) };
}
