/**
 * Config file loading with env interpolation.
 */

import { dirname, extname, resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";
import type { ProcessIncludesOptions } from "./include.js";
import { processIncludes } from "./include.js";

/** Options for `loadConfig()` and `loadConfigFromString()`. */
export interface LoadConfigOptions {
  /** Environment variables for interpolation. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Maximum `$include` depth. Defaults to 5. */
  readonly maxIncludeDepth?: number | undefined;
}

// ---------------------------------------------------------------------------
// Env interpolation
// ---------------------------------------------------------------------------

/**
 * Pattern matching `${VAR}` or `${VAR:-default}`.
 *
 * Captures:
 *   1 = variable name
 *   2 = default value (after `:-`)
 */
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Replaces `${VAR}` and `${VAR:-default}` patterns with environment values.
 *
 * - `${VAR}` resolves to `env[VAR]` or empty string if unset.
 * - `${VAR:-fallback}` resolves to `env[VAR]` or `"fallback"` if unset.
 */
export function interpolateEnv(
  raw: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return raw.replace(ENV_PATTERN, (_match, name: string, fallback?: string) => {
    const value = env[name];
    if (value !== undefined && value !== "") {
      return value;
    }
    return fallback ?? "";
  });
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

function parseContent(
  content: string,
  filePath: string,
): Result<Record<string, unknown>, KoiError> {
  const ext = extname(filePath).toLowerCase();
  try {
    if (ext === ".json") {
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Config file must be a JSON object: ${filePath}`,
            retryable: false,
            context: { filePath },
          },
        };
      }
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    // Default to YAML
    const parsed: unknown = Bun.YAML.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Config file must be a YAML mapping: ${filePath}`,
          retryable: false,
          context: { filePath },
        },
      };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Failed to parse config file: ${filePath}`,
        retryable: false,
        context: { filePath },
        cause,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synchronously parses a config string with env interpolation.
 *
 * Does NOT process `$include` directives — use `loadConfig()` for that.
 * Useful for testing or when the content is already in memory.
 */
export function loadConfigFromString(
  content: string,
  filePath: string,
  options?: LoadConfigOptions,
): Result<Record<string, unknown>, KoiError> {
  const interpolated = interpolateEnv(content, options?.env);
  return parseContent(interpolated, filePath);
}

/**
 * Reads a config file from disk, interpolates env vars, processes `$include`
 * directives, and returns the merged raw config object.
 */
export async function loadConfig(
  filePath: string,
  options?: LoadConfigOptions,
): Promise<Result<Record<string, unknown>, KoiError>> {
  const absolutePath = resolve(filePath);

  let content: string;
  try {
    content = await Bun.file(absolutePath).text();
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Config file not found: ${absolutePath}`,
        retryable: false,
        context: { filePath: absolutePath },
        cause,
      },
    };
  }

  const parseResult = loadConfigFromString(content, absolutePath, options);
  if (!parseResult.ok) {
    return parseResult;
  }

  const includeOptions: ProcessIncludesOptions = {
    env: options?.env,
    maxDepth: options?.maxIncludeDepth,
  };

  return processIncludes(parseResult.value, dirname(absolutePath), includeOptions);
}
