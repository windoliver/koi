/**
 * Shared argument parsing utilities for filesystem tool factories.
 *
 * Eliminates `as Type` assertions by performing runtime type narrowing
 * on raw JsonObject args from the LLM.
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

export function parseArray(args: JsonObject, key: string): ParseResult<readonly unknown[]> {
  const value = args[key];
  if (!Array.isArray(value)) {
    return { ok: false, err: { error: `${key} must be an array`, code: "VALIDATION" } };
  }
  return { ok: true, value };
}
