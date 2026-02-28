/**
 * Shared argument parsing utilities for registry tool factories.
 *
 * Eliminates `as Type` assertions by performing runtime type narrowing
 * on raw JsonObject args from the LLM.
 *
 * TODO: Extract to @koi/validation (L0u) once a third consumer appears.
 */

import type { JsonObject } from "@koi/core";

interface ValidationError {
  readonly error: string;
  readonly code: "VALIDATION";
}

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly err: ValidationError };

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
  if (typeof value !== "number") {
    return { ok: false, err: { error: `${key} must be a number`, code: "VALIDATION" } };
  }
  return { ok: true, value };
}

export function parseEnum<T extends string>(
  args: JsonObject,
  key: string,
  allowed: readonly T[],
): ParseResult<T> {
  const value = args[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return {
      ok: false,
      err: {
        error: `${key} must be one of: ${allowed.join(", ")}`,
        code: "VALIDATION",
      },
    };
  }
  return { ok: true, value: value as T };
}

export function parseOptionalEnum<T extends string>(
  args: JsonObject,
  key: string,
  allowed: readonly T[],
): ParseResult<T | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return {
      ok: false,
      err: {
        error: `${key} must be one of: ${allowed.join(", ")}`,
        code: "VALIDATION",
      },
    };
  }
  return { ok: true, value: value as T };
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
  return { ok: true, value: value as readonly string[] };
}
