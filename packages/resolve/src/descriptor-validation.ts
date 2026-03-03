/**
 * Shared validation helpers for BrickDescriptor optionsValidator functions.
 *
 * Centralises the typeof-object boilerplate that every descriptor.ts repeats.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

/**
 * Validates descriptor options, allowing null/undefined as empty object.
 * Use for descriptors where options are optional (engines, some channels).
 */
export function validateOptionalDescriptorOptions(
  input: unknown,
  label: string,
): Result<Record<string, unknown>, KoiError> {
  if (input === null || input === undefined) {
    return { ok: true, value: {} };
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `${label} options must be an object`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input as Record<string, unknown> };
}

/**
 * Validates descriptor options, requiring a non-null object.
 * Use for descriptors where options are required (most middleware).
 */
export function validateRequiredDescriptorOptions(
  input: unknown,
  label: string,
): Result<Record<string, unknown>, KoiError> {
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `${label} options must be an object`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input as Record<string, unknown> };
}
