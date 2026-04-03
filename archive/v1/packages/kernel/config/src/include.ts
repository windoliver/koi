/**
 * $include directive processing — splits large configs across multiple files.
 *
 * Extracts `$include` from a parsed config, loads referenced files,
 * deep-merges them in order (main config wins), with cycle detection.
 */

import { dirname, resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";
import type { LoadConfigOptions } from "./loader.js";
import { loadConfigFromString } from "./loader.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ProcessIncludesOptions {
  /** Maximum nesting depth for recursive includes. Default: 5. */
  readonly maxDepth?: number;
  /** Environment variables for interpolation in included files. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Keys that must never be assigned to a plain object (prototype pollution). */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Full deep merge that includes ALL keys from both objects.
 * Unlike the package's `deepMerge` (which only keeps base keys),
 * this variant is needed because includes merge arbitrary partial configs.
 * Filters dangerous keys to prevent prototype pollution.
 */
function fullMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const allKeys = new Set([...Object.keys(base), ...Object.keys(override)]);

  for (const key of allKeys) {
    if (DANGEROUS_KEYS.has(key)) continue;

    const baseVal = base[key];
    const overrideVal = override[key];

    if (overrideVal === undefined) {
      result[key] = baseVal;
    } else if (baseVal === undefined) {
      result[key] = overrideVal;
    } else if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = fullMerge(baseVal, overrideVal);
    } else {
      result[key] = overrideVal;
    }
  }

  return result;
}

/** Loads, interpolates env, and parses a single YAML or JSON file. */
async function loadIncludeFile(
  filePath: string,
  loaderOptions?: LoadConfigOptions,
): Promise<Result<Record<string, unknown>, KoiError>> {
  let raw: string;
  try {
    raw = await Bun.file(filePath).text();
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Include file not found: ${filePath}`,
        retryable: false,
        cause,
        context: { filePath },
      },
    };
  }

  return loadConfigFromString(raw, filePath, loaderOptions);
}

/** Recursively resolves includes for a parsed object. */
async function resolveIncludes(
  parsed: Record<string, unknown>,
  parentPath: string,
  depth: number,
  maxDepth: number,
  ancestors: Set<string>,
  loaderOptions?: LoadConfigOptions,
): Promise<Result<Record<string, unknown>, KoiError>> {
  const includeVal = parsed.$include;
  if (includeVal === undefined) {
    return { ok: true, value: parsed };
  }

  // Validate $include type
  if (typeof includeVal !== "string" && !Array.isArray(includeVal)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "$include must be a string or array of strings",
        retryable: false,
        context: { filePath: parentPath },
      },
    };
  }

  if (Array.isArray(includeVal) && !includeVal.every((v: unknown) => typeof v === "string")) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "$include must be a string or array of strings",
        retryable: false,
        context: { filePath: parentPath },
      },
    };
  }

  const paths: readonly string[] =
    typeof includeVal === "string" ? [includeVal] : (includeVal as readonly string[]);

  if (depth >= maxDepth) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `$include max depth exceeded (${maxDepth})`,
        retryable: false,
        context: { filePath: parentPath, maxDepth },
      },
    };
  }

  const parentDir = dirname(parentPath);

  // Strip $include from the main object
  const { $include: _, ...mainWithoutInclude } = parsed;

  // Merge includes in order, then main wins
  let merged: Record<string, unknown> = {};
  for (const includePath of paths) {
    const absPath = resolve(parentDir, includePath);

    // Cycle detection: only check ancestors (not all previously visited files)
    // This allows diamond-shaped include graphs (A includes B and C, both include D).
    if (ancestors.has(absPath)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `$include cycle detected: ${absPath}`,
          retryable: false,
          context: { filePath: absPath },
        },
      };
    }

    const childAncestors = new Set(ancestors);
    childAncestors.add(absPath);

    const loaded = await loadIncludeFile(absPath, loaderOptions);
    if (!loaded.ok) {
      return loaded;
    }

    // Recursively resolve includes in the loaded file
    const resolved = await resolveIncludes(
      loaded.value,
      absPath,
      depth + 1,
      maxDepth,
      childAncestors,
      loaderOptions,
    );
    if (!resolved.ok) {
      return resolved;
    }

    merged = fullMerge(merged, resolved.value);
  }

  // Main config wins
  return { ok: true, value: fullMerge(merged, mainWithoutInclude) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Processes `$include` directives in a parsed config object.
 *
 * - Loads referenced files relative to the parent config's directory.
 * - Included files undergo env interpolation (same as the main config).
 * - Deep-merges in order: first include, then subsequent includes, then main (main wins).
 * - Detects cycles via ancestor tracking (diamond-shaped graphs are allowed).
 * - Enforces max depth (default: 5).
 * - Returns the original object unchanged if no `$include` key is present.
 *
 * @param parsed - The parsed config object (may contain `$include`).
 * @param parentFilePath - Path to the file that was parsed (for resolving relative paths).
 * @param options - Optional settings (maxDepth, env).
 */
export async function processIncludes(
  parsed: Record<string, unknown>,
  parentFilePath: string,
  options?: ProcessIncludesOptions,
): Promise<Result<Record<string, unknown>, KoiError>> {
  const maxDepth = options?.maxDepth ?? 5;
  const ancestors = new Set<string>([resolve(parentFilePath)]);
  const loaderOptions: LoadConfigOptions | undefined = options?.env
    ? { env: options.env }
    : undefined;
  return resolveIncludes(parsed, parentFilePath, 0, maxDepth, ancestors, loaderOptions);
}
