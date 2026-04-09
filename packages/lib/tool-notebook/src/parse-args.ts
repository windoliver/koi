/**
 * Argument parsing helpers for notebook tool factories.
 *
 * Returns discriminated unions instead of `as Type` assertions,
 * performing runtime type narrowing on raw JsonObject args from the LLM.
 */

import { resolve } from "node:path";
import type { JsonObject } from "@koi/core";
import type { CellType } from "./notebook-parser.js";

interface ValidationError {
  readonly error: string;
  readonly code: "VALIDATION";
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly err: ValidationError };

export function parsePath(args: JsonObject, key: string, cwd?: string): ParseResult<string> {
  const value = args[key];
  if (typeof value !== "string") {
    return { ok: false, err: { error: `${key} must be a string`, code: "VALIDATION" } };
  }
  if (value.trim().length === 0) {
    return { ok: false, err: { error: `${key} must be a non-empty string`, code: "VALIDATION" } };
  }
  // Workspace containment: resolve and verify path stays under cwd
  if (cwd !== undefined) {
    const resolved = resolve(cwd, value);
    const normalizedCwd = resolve(cwd);
    if (!resolved.startsWith(`${normalizedCwd}/`) && resolved !== normalizedCwd) {
      return {
        ok: false,
        err: {
          error: `${key} must be within the workspace root (${normalizedCwd})`,
          code: "VALIDATION",
        },
      };
    }
    return { ok: true, value: resolved };
  }
  return { ok: true, value };
}

export function parseCellType(args: JsonObject, key: string): ParseResult<CellType> {
  const value = args[key];
  if (value !== "code" && value !== "markdown" && value !== "raw") {
    return {
      ok: false,
      err: {
        error: `${key} must be one of: "code", "markdown", "raw"`,
        code: "VALIDATION",
      },
    };
  }
  return { ok: true, value };
}

export function parseSource(args: JsonObject, key: string): ParseResult<string> {
  const value = args[key];
  if (typeof value !== "string") {
    return { ok: false, err: { error: `${key} must be a string`, code: "VALIDATION" } };
  }
  return { ok: true, value };
}

export function parseOptionalIndex(args: JsonObject, key: string): ParseResult<number | undefined> {
  const value = args[key];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, err: { error: `${key} must be an integer`, code: "VALIDATION" } };
  }
  return { ok: true, value };
}

export function parseRequiredIndex(args: JsonObject, key: string): ParseResult<number> {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, err: { error: `${key} must be an integer`, code: "VALIDATION" } };
  }
  return { ok: true, value };
}
