/**
 * Map `gh` CLI failures to KoiError values.
 *
 * Pattern-matches stderr content and exit codes following
 * the same approach as @koi/git-utils parseGitError.
 */

import type { KoiError, Result } from "@koi/core";

/**
 * Parse stderr from a `gh` CLI invocation into a structured KoiError.
 *
 * Exit code 4 = insufficient permissions (GitHub CLI convention).
 */
export function parseGhError(stderr: string, exitCode: number, args: readonly string[]): KoiError {
  const trimmed = stderr.trim();
  const command = `gh ${args.join(" ")}`;

  if (exitCode === 4) {
    return {
      code: "PERMISSION",
      message: trimmed || "Insufficient permissions",
      retryable: false,
      context: { command },
    };
  }

  if (/rate limit/i.test(trimmed)) {
    return {
      code: "RATE_LIMIT",
      message: trimmed,
      retryable: true,
      context: { command },
    };
  }

  if (/not found/i.test(trimmed)) {
    return {
      code: "NOT_FOUND",
      message: trimmed,
      retryable: false,
      context: { command },
    };
  }

  if (/already exists/i.test(trimmed)) {
    return {
      code: "CONFLICT",
      message: trimmed,
      retryable: false,
      context: { command },
    };
  }

  if (/merge conflict/i.test(trimmed)) {
    return {
      code: "CONFLICT",
      message: trimmed,
      retryable: false,
      context: { command },
    };
  }

  if (/not mergeable/i.test(trimmed)) {
    return {
      code: "VALIDATION",
      message: trimmed,
      retryable: false,
      context: { command },
    };
  }

  return {
    code: "EXTERNAL",
    message: `gh ${args[0] ?? ""} failed: ${trimmed || `exit code ${exitCode}`}`,
    retryable: false,
    context: { command },
  };
}

/**
 * Attempt to parse a JSON response from gh output.
 * Returns a KoiError if parsing fails.
 */
export function parseGhJson(raw: string): Result<unknown, KoiError> {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Failed to parse gh JSON output: ${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
        cause: e,
      },
    };
  }
}

/** Type guard: checks whether a value is a non-null object (Record-like). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Map a KoiError to the standard tool error response shape. */
export function mapErrorResult(error: KoiError): { readonly error: string; readonly code: string } {
  return { error: error.message, code: error.code };
}
