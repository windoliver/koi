/**
 * Argument parsing helpers for code-mode tools.
 *
 * Copied pattern from @koi/filesystem (L2 cannot import peer L2).
 */

import type { JsonObject } from "@koi/core";

export interface ValidationError {
  readonly error: string;
  readonly code: "VALIDATION";
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly err: ValidationError };

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

export function parseArray(args: JsonObject, key: string): ParseResult<readonly unknown[]> {
  const value = args[key];
  if (!Array.isArray(value)) {
    return { ok: false, err: { error: `${key} must be an array`, code: "VALIDATION" } };
  }
  return { ok: true, value };
}
