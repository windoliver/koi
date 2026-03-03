/**
 * Config file loader — reads YAML or JSON config files with env interpolation.
 *
 * Pipeline: read file → detect format → interpolate env → parse → return raw object.
 * Validation is done separately via validateKoiConfig() or resolveConfig().
 */

import type { KoiError, Result } from "@koi/core";
import type { ProcessIncludesOptions } from "./include.js";
import { processIncludes } from "./include.js";

// ---------------------------------------------------------------------------
// Env interpolation (same pattern as @koi/manifest)
// ---------------------------------------------------------------------------

/** Pattern matches `${VAR}` and `${VAR:-default}` */
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g;

/**
 * Interpolates `${VAR}` and `${VAR:-default}` references in a string.
 */
export function interpolateEnv(
  raw: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return raw.replace(ENV_PATTERN, (_match, name: string, defaultValue?: string) => {
    const value = env[name];
    if (value !== undefined) {
      return value;
    }
    return defaultValue ?? "";
  });
}

// ---------------------------------------------------------------------------
// Loader options
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** Environment variables for interpolation. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Options for `$include` directive processing. */
  readonly includes?: ProcessIncludesOptions | undefined;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Loads a config file (YAML or JSON) from disk, interpolates env vars, and returns
 * the parsed object. Does NOT validate — call validateKoiConfig() on the result.
 *
 * Format detection:
 * - `.json` extension → JSON.parse
 * - `.yaml` / `.yml` or anything else → Bun.YAML.parse
 *
 * @param filePath - Path to the config file.
 * @param options - Optional loader options.
 * @returns Raw parsed config object, or a NOT_FOUND / VALIDATION error.
 */
export async function loadConfig(
  filePath: string,
  options?: LoadConfigOptions,
): Promise<Result<Record<string, unknown>, KoiError>> {
  // Read file
  let raw: string;
  try {
    raw = await Bun.file(filePath).text();
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Failed to read config file: ${filePath}`,
        retryable: false,
        cause,
        context: { filePath },
      },
    };
  }

  const parsed = loadConfigFromString(raw, filePath, options);
  if (!parsed.ok) {
    return parsed;
  }

  // Process $include directives (only for file-based loading)
  return processIncludes(parsed.value, filePath, options?.includes);
}

/**
 * Parses a config string (YAML or JSON) with env interpolation.
 * Synchronous variant for testing and embedding.
 *
 * @param content - Raw file content.
 * @param filePath - Path used for format detection (extension check).
 * @param options - Optional loader options.
 */
export function loadConfigFromString(
  content: string,
  filePath: string,
  options?: LoadConfigOptions,
): Result<Record<string, unknown>, KoiError> {
  const interpolated = interpolateEnv(content, options?.env);

  const isJson = filePath.endsWith(".json");

  let parsed: unknown;
  try {
    parsed = isJson ? JSON.parse(interpolated) : Bun.YAML.parse(interpolated);
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Config parse error (${isJson ? "JSON" : "YAML"}): ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
        cause,
        context: { filePath },
      },
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config file must contain a plain object at the top level",
        retryable: false,
        context: { filePath },
      },
    };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}
