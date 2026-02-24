/**
 * Shared argument parsing utilities for browser tool factories.
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

/** Parse a ref key (e.g., "e1", "e42"). Must match /^e\d+$/ format. */
export function parseRef(args: JsonObject, key: string): ParseResult<string> {
  const value = args[key];
  if (typeof value !== "string" || !/^e\d+$/.test(value)) {
    return {
      ok: false,
      err: {
        error: `${key} must be a ref key like "e1" or "e42" (from browser_snapshot output)`,
        code: "VALIDATION",
      },
    };
  }
  return { ok: true, value };
}

/** Parse an optional ref key (e.g., "e1", "e42"). Returns undefined if key absent. */
export function parseOptionalRef(args: JsonObject, key: string): ParseResult<string | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || !/^e\d+$/.test(value)) {
    return {
      ok: false,
      err: {
        error: `${key} must be a ref key like "e1" or "e42" (from browser_snapshot output)`,
        code: "VALIDATION",
      },
    };
  }
  return { ok: true, value };
}

/** Parse an optional snapshotId (opaque string). */
export function parseOptionalSnapshotId(
  args: JsonObject,
  key: string,
): ParseResult<string | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, err: { error: `${key} must be a non-empty string`, code: "VALIDATION" } };
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

/** Parse a required timeout in ms. */
export function parseTimeout(
  args: JsonObject,
  key: string,
  minMs: number,
  maxMs: number,
): ParseResult<number> {
  const value = args[key];
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

/** Parse fill_form fields array: [{ref, value, clear?}] */
export function parseFormFields(
  args: JsonObject,
  key: string,
): ParseResult<readonly { ref: string; value: string; clear?: boolean }[]> {
  const raw = args[key];
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      err: {
        error: `${key} must be a non-empty array of {ref, value} objects`,
        code: "VALIDATION",
      },
    };
  }
  const fields: { ref: string; value: string; clear?: boolean }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "object" || item === null) {
      return {
        ok: false,
        err: { error: `${key}[${i}] must be an object`, code: "VALIDATION" },
      };
    }
    const field = item as Record<string, unknown>;
    if (typeof field.ref !== "string" || !/^e\d+$/.test(field.ref)) {
      return {
        ok: false,
        err: { error: `${key}[${i}].ref must be a ref key like "e1"`, code: "VALIDATION" },
      };
    }
    if (typeof field.value !== "string") {
      return {
        ok: false,
        err: { error: `${key}[${i}].value must be a string`, code: "VALIDATION" },
      };
    }
    const clear = field.clear;
    if (clear !== undefined && typeof clear !== "boolean") {
      return {
        ok: false,
        err: { error: `${key}[${i}].clear must be a boolean`, code: "VALIDATION" },
      };
    }
    fields.push({
      ref: field.ref as string,
      value: field.value as string,
      ...(clear !== undefined && { clear: clear as boolean }),
    });
  }
  return { ok: true, value: fields };
}

type ScrollDirection = "up" | "down" | "left" | "right";
const SCROLL_DIRECTIONS: readonly ScrollDirection[] = ["up", "down", "left", "right"];

export function parseOptionalScrollDirection(
  args: JsonObject,
  key: string,
): ParseResult<ScrollDirection | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (!SCROLL_DIRECTIONS.includes(value as ScrollDirection)) {
    return {
      ok: false,
      err: {
        error: `${key} must be one of: up, down, left, right`,
        code: "VALIDATION",
      },
    };
  }
  return { ok: true, value: value as ScrollDirection };
}

type WaitKind = "timeout" | "selector" | "navigation";
const WAIT_KINDS: readonly WaitKind[] = ["timeout", "selector", "navigation"];

export function parseWaitKind(args: JsonObject, key: string): ParseResult<WaitKind> {
  const value = args[key];
  if (!WAIT_KINDS.includes(value as WaitKind)) {
    return {
      ok: false,
      err: {
        error: `${key} must be one of: timeout, selector, navigation`,
        code: "VALIDATION",
      },
    };
  }
  return { ok: true, value: value as WaitKind };
}

type SelectorState = "visible" | "hidden" | "attached" | "detached";
const SELECTOR_STATES: readonly SelectorState[] = ["visible", "hidden", "attached", "detached"];

export function parseOptionalSelectorState(
  args: JsonObject,
  key: string,
): ParseResult<SelectorState | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (!SELECTOR_STATES.includes(value as SelectorState)) {
    return {
      ok: false,
      err: {
        error: `${key} must be one of: visible, hidden, attached, detached`,
        code: "VALIDATION",
      },
    };
  }
  return { ok: true, value: value as SelectorState };
}

type WaitUntil = "load" | "networkidle" | "commit" | "domcontentloaded";
const WAIT_UNTIL_VALUES: readonly WaitUntil[] = [
  "load",
  "networkidle",
  "commit",
  "domcontentloaded",
];

export function parseOptionalWaitUntil(
  args: JsonObject,
  key: string,
): ParseResult<WaitUntil | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (!WAIT_UNTIL_VALUES.includes(value as WaitUntil)) {
    return {
      ok: false,
      err: {
        error: `${key} must be one of: load, networkidle, commit, domcontentloaded`,
        code: "VALIDATION",
      },
    };
  }
  return { ok: true, value: value as WaitUntil };
}
