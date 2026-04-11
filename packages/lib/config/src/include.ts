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
    undefined,
  );
}

/**
 * Result shape for `processIncludesWithFiles`: `files` is ALWAYS
 * populated with the set of paths that were **successfully opened**
 * (the partial include graph), regardless of whether the call succeeded.
 *
 * **KNOWN LIMITATION**: missing include paths are NOT included. A
 * rejected reload caused by a brand-new missing `$include` file does
 * not track that path, so creating the file alone will not trigger a
 * recovery reload — the user must re-touch the root config (or any
 * other already-watched file) to retrigger loading. This is a
 * deliberate scope choice to avoid the complexity of directory-level
 * watching or bounded existence probes. See `docs/L2/config.md` for
 * the full documented limitation.
 */
export type ProcessIncludesWithFilesResult =
  | {
      readonly ok: true;
      readonly value: Record<string, unknown>;
      readonly files: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: KoiError;
      readonly files: readonly string[];
    };

/**
 * Like `processIncludes`, but also returns the set of absolute file paths
 * that were actually read during `$include` resolution. The files list is
 * populated even on failure (it contains every file that was opened
 * before the error). Used by `ConfigManager.watch()` to arm watchers on
 * every file in the include graph, not just the root.
 */
export async function processIncludesWithFiles(
  parsed: Readonly<Record<string, unknown>>,
  parentDir: string,
  options?: ProcessIncludesOptions,
): Promise<ProcessIncludesWithFilesResult> {
  const files = new Set<string>();
  const result = await processIncludesRecursive(
    parsed,
    parentDir,
    options?.env,
    options?.maxDepth ?? DEFAULT_MAX_DEPTH,
    0,
    new Set(),
    files,
  );
  if (!result.ok) {
    return { ok: false, error: result.error, files: [...files] };
  }
  return { ok: true, value: result.value, files: [...files] };
}

async function processIncludesRecursive(
  parsed: Readonly<Record<string, unknown>>,
  parentDir: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  maxDepth: number,
  currentDepth: number,
  ancestors: ReadonlySet<string>,
  loadedFiles: Set<string> | undefined,
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

    // Track the include path AFTER a successful read, not before.
    // Missing include files are NOT added to `loadedFiles` — see the
    // KNOWN LIMITATION block on `ProcessIncludesWithFilesResult`. In
    // short: tracking missing paths would require either arming a
    // watcher per missing path (unbounded retry loops) or directory-
    // level watching (significant new complexity). The deliberate
    // choice is to omit missing paths and require the user to
    // re-touch the root file for recovery in the "newly-referenced
    // missing include" case.
    loadedFiles?.add(includePath);

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
      loadedFiles,
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
