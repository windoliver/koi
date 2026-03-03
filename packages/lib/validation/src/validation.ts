/**
 * Shared Zod → KoiError validation utilities.
 *
 * Eliminates duplication of `zodToKoiError` across L2 packages.
 */

import type { KoiError, Result } from "@koi/core";
import type { z } from "zod";

/**
 * Converts a Zod validation error into a `KoiError` with code `VALIDATION`.
 *
 * @param zodError - The Zod error to convert.
 * @param prefix - Optional prefix for the error message (e.g., "MCP config validation failed").
 *                 Defaults to "Validation failed".
 */
export function zodToKoiError(zodError: z.core.$ZodError, prefix?: string): KoiError {
  const issues = zodError.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));

  const label = prefix ?? "Validation failed";

  return {
    code: "VALIDATION",
    message: `${label}: ${issues.map((i) => `${i.path || "root"}: ${i.message}`).join("; ")}`,
    retryable: false,
    context: { issues },
  };
}

/**
 * Validates `raw` input against a Zod schema and returns a `Result<T, KoiError>`.
 *
 * @param schema - Zod schema to validate against.
 * @param raw - Unknown input to validate.
 * @param prefix - Optional error message prefix.
 */
export function validateWith<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  prefix?: string,
): Result<T, KoiError> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: zodToKoiError(result.error, prefix) };
  }
  return { ok: true, value: result.data };
}
