/**
 * Generic config resolution: validate raw input, merge with defaults.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import type { z } from "zod";
import { deepMerge } from "./merge.js";

/**
 * Validates `raw` against `schema`, then merges the result with `defaults`.
 *
 * Defaults fill gaps but validated values always win.
 * Returns `Result<T, KoiError>` — never throws for validation errors.
 */
export function resolveConfig<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  defaults: T,
  raw: unknown,
  prefix?: string,
): Result<T, KoiError> {
  const validated = validateWith(schema, raw, prefix);
  if (!validated.ok) {
    return validated;
  }
  return { ok: true, value: deepMerge(defaults, validated.value) };
}
