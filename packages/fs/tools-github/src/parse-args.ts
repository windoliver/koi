/**
 * Argument parsing utilities for GitHub tool factories.
 *
 * Generic parsers copied from @koi/tool-browser (parse-args.ts).
 * GitHub-specific parsers added for PR numbers and enum values.
 */

import type { JsonObject } from "@koi/core";

interface ValidationError {
  readonly error: string;
  readonly code: "VALIDATION";
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly err: ValidationError };

// ---------------------------------------------------------------------------
// Generic parsers (from tool-browser)
// ---------------------------------------------------------------------------

export function parseString(args: JsonObject, key: string): ParseResult<string> {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, err: { error: `${key} must be a non-empty string`, code: "VALIDATION" } };
  }
  return { ok: true, value };
}

export function parseOptionalString(
  args: JsonObject,
  key: string,
): ParseResult<string | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return { ok: false, err: { error: `${key} must be a string`, code: "VALIDATION" } };
  }
  return { ok: true, value };
}

export function parseOptionalNumber(
  args: JsonObject,
  key: string,
): ParseResult<number | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number") {
    return { ok: false, err: { error: `${key} must be a number`, code: "VALIDATION" } };
  }
  return { ok: true, value };
}

export function parseOptionalBoolean(
  args: JsonObject,
  key: string,
): ParseResult<boolean | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "boolean") {
    return { ok: false, err: { error: `${key} must be a boolean`, code: "VALIDATION" } };
  }
  return { ok: true, value };
}

/** Parse a timeout in ms, validating it falls within [minMs, maxMs]. */
export function parseOptionalTimeout(
  args: JsonObject,
  key: string,
  minMs: number,
  maxMs: number,
): ParseResult<number | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, err: { error: `${key} must be a number`, code: "VALIDATION" } };
  }
  if (value < minMs || value > maxMs) {
    return {
      ok: false,
      err: {
        error: `${key} must be between ${minMs} and ${maxMs} ms`,
        code: "VALIDATION",
      },
    };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// GitHub-specific parsers
// ---------------------------------------------------------------------------

/** Parse a required PR number (positive integer). */
export function parsePrNumber(args: JsonObject, key: string): ParseResult<number> {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return {
      ok: false,
      err: { error: `${key} must be a positive integer`, code: "VALIDATION" },
    };
  }
  return { ok: true, value };
}

/** Type guard that narrows `unknown` to a member of a string literal union. */
function memberOf<T extends string>(set: readonly T[], value: unknown): value is T {
  return (set as readonly unknown[]).includes(value);
}

/** Parse a required enum value from a known set. */
export function parseEnum<T extends string>(
  args: JsonObject,
  key: string,
  values: readonly T[],
): ParseResult<T> {
  const value = args[key];
  if (!memberOf(values, value)) {
    return {
      ok: false,
      err: {
        error: `${key} must be one of: ${values.join(", ")}`,
        code: "VALIDATION",
      },
    };
  }
  return { ok: true, value };
}

/** Parse an optional enum value from a known set. */
export function parseOptionalEnum<T extends string>(
  args: JsonObject,
  key: string,
  values: readonly T[],
): ParseResult<T | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (!memberOf(values, value)) {
    return {
      ok: false,
      err: {
        error: `${key} must be one of: ${values.join(", ")}`,
        code: "VALIDATION",
      },
    };
  }
  return { ok: true, value };
}
