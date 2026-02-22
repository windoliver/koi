/**
 * Generic resolveConfig<T>() — DRYs up per-package config resolution.
 *
 * Pattern: validate raw input → deep-merge with defaults → return Result<T>.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import type { z } from "zod";
import { deepMerge } from "./merge.js";

/**
 * Validates `raw` against `schema`, then deep-merges with `defaults`.
 *
 * The schema type uses `Record<string, unknown>` rather than `Partial<T>`
 * because Zod's `.optional()` produces `T | undefined` which is incompatible
 * with `Partial<T>` under `exactOptionalPropertyTypes`. Since the parsed
 * output is deep-merged with fully-typed `defaults`, type safety is preserved.
 *
 * @param schema - Zod schema for partial input (all fields optional or with defaults).
 * @param defaults - Full default config object.
 * @param raw - Unknown input to validate and merge.
 * @param prefix - Optional error message prefix.
 * @returns Result containing the fully resolved config or a validation error.
 */
export function resolveConfig<T extends Record<string, unknown>>(
  schema: z.ZodType<Record<string, unknown>>,
  defaults: T,
  raw: unknown,
  prefix?: string,
): Result<T, KoiError> {
  const parsed = validateWith(schema, raw, prefix);
  if (!parsed.ok) {
    return parsed;
  }

  // Safe: schema has validated the shape; deepMerge only uses keys from defaults
  const merged = deepMerge(defaults, parsed.value as unknown as Partial<T>);
  return { ok: true, value: merged };
}
