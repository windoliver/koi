/**
 * Shared argument parsing utilities for memory tool factories.
 *
 * Performs runtime type narrowing on raw JsonObject args from the LLM,
 * eliminating the need for `as Type` assertions.
 */

import type { JsonObject } from "@koi/core";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ValidationError {
  readonly error: string;
  readonly code: "VALIDATION";
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly err: ValidationError };

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export function parseString(args: JsonObject, key: string): ParseResult<string> {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return {
      ok: false,
      err: { error: `${key} must be a non-empty string`, code: "VALIDATION" },
    };
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
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, err: { error: `${key} must be a finite number`, code: "VALIDATION" } };
  }
  return { ok: true, value };
}

export function parseOptionalInteger(
  args: JsonObject,
  key: string,
): ParseResult<number | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, err: { error: `${key} must be an integer`, code: "VALIDATION" } };
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

export function parseOptionalStringArray(
  args: JsonObject,
  key: string,
): ParseResult<readonly string[] | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    return {
      ok: false,
      err: { error: `${key} must be an array of strings`, code: "VALIDATION" },
    };
  }
  // Copy to a new array to avoid returning a mutable reference
  return { ok: true, value: [...value] };
}

/** Check if a string is in a readonly string array (type-safe without assertion). */
function includesString(arr: readonly string[], value: string): boolean {
  return arr.includes(value);
}

export function parseOptionalEnum<const T extends string>(
  args: JsonObject,
  key: string,
  allowed: readonly T[],
): ParseResult<T | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || !includesString(allowed, value)) {
    return {
      ok: false,
      err: {
        error: `${key} must be one of: ${allowed.join(", ")}`,
        code: "VALIDATION",
      },
    };
  }
  // Type-safe: value is a string that is known to be in the allowed tuple.
  // We find the matching element to return it with the correct narrowed type.
  const match = allowed.find((a) => a === value);
  if (match === undefined) return { ok: true, value: undefined };
  return { ok: true, value: match };
}

/**
 * Strict ISO 8601 shape check — rejects locale-ish strings that Date.parse
 * would accept (e.g. "March 5, 2026"). Accepts YYYY-MM-DD with optional
 * time, timezone offset, or trailing Z.
 */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function parseOptionalTimestamp(
  args: JsonObject,
  key: string,
): ParseResult<number | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return {
      ok: false,
      err: { error: `${key} must be an ISO 8601 timestamp string`, code: "VALIDATION" },
    };
  }
  if (!ISO_8601_RE.test(value)) {
    return {
      ok: false,
      err: { error: `${key} must be a valid ISO 8601 timestamp`, code: "VALIDATION" },
    };
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return {
      ok: false,
      err: { error: `${key} must be a valid ISO 8601 timestamp`, code: "VALIDATION" },
    };
  }
  // Roundtrip check — reject impossible calendar dates like Feb 30
  // that Date.parse silently rolls forward
  const date = new Date(ms);
  const inputDay = Number.parseInt(value.slice(8, 10), 10);
  if (date.getUTCDate() !== inputDay) {
    return {
      ok: false,
      err: { error: `${key} must be a valid calendar date`, code: "VALIDATION" },
    };
  }
  return { ok: true, value: ms };
}
