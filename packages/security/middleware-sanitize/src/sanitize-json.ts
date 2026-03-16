/**
 * Recursive string-field walker for sanitizing JSON objects (tool I/O).
 * Depth-limited to prevent stack overflow on deeply nested structures.
 */

import { sanitizeString } from "./sanitize-block.js";
import type { SanitizationEvent, SanitizationLocation, SanitizeRule } from "./types.js";

/** Default maximum recursion depth. */
const DEFAULT_MAX_DEPTH = 10;

/** Result of walking and sanitizing a JSON value. */
export interface WalkJsonResult {
  readonly value: unknown;
  readonly blocked: boolean;
  readonly events: readonly SanitizationEvent[];
}

/**
 * Recursively traverse a value, sanitizing all string leaves.
 * Returns a new immutable structure — the original is never mutated.
 * Arrays and objects are reconstructed only if a string leaf changes.
 */
export function walkJsonStrings(
  value: unknown,
  rules: readonly SanitizeRule[],
  location: SanitizationLocation,
  onSanitization?: (event: SanitizationEvent) => void,
  maxDepth: number = DEFAULT_MAX_DEPTH,
  maxContentLength?: number,
): WalkJsonResult {
  return walk(value, rules, location, onSanitization, maxDepth, 0, maxContentLength);
}

function walk(
  value: unknown,
  rules: readonly SanitizeRule[],
  location: SanitizationLocation,
  onSanitization: ((event: SanitizationEvent) => void) | undefined,
  maxDepth: number,
  depth: number,
  maxContentLength?: number,
): WalkJsonResult {
  // Depth limit reached — return as-is
  if (depth > maxDepth) {
    return { value, blocked: false, events: [] };
  }

  // String leaf — apply rules (skip if oversized — ReDoS guard)
  if (typeof value === "string") {
    if (maxContentLength !== undefined && value.length > maxContentLength) {
      return { value, blocked: false, events: [] };
    }
    const result = sanitizeString(value, rules, location, undefined, onSanitization);
    return { value: result.text, blocked: result.blocked, events: result.events };
  }

  // Null, undefined, number, boolean — pass through
  if (value === null || value === undefined || typeof value !== "object") {
    return { value, blocked: false, events: [] };
  }

  // Array — recurse elements
  if (Array.isArray(value)) {
    const allEvents: SanitizationEvent[] = [];
    // let justified: tracks whether any element was blocked
    let anyBlocked = false;
    // let justified: tracks whether any element was modified
    let anyChanged = false;

    const newArr = value.map((item: unknown) => {
      const result = walk(
        item,
        rules,
        location,
        onSanitization,
        maxDepth,
        depth + 1,
        maxContentLength,
      );
      if (result.blocked) {
        anyBlocked = true;
      }
      if (result.events.length > 0) {
        anyChanged = true;
        allEvents.push(...result.events);
      }
      return result.value;
    });

    return { value: anyChanged ? newArr : value, blocked: anyBlocked, events: allEvents };
  }

  // Object — recurse values.
  // Cast justified: value is non-null, non-array object after Array.isArray and typeof guards.
  // Object.keys requires an object argument; TypeScript doesn't narrow `object` to Record.
  const obj: Record<string, unknown> = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const allEvents: SanitizationEvent[] = [];
  // let justified: tracks whether any field was blocked
  let anyBlocked = false;
  // let justified: tracks whether any field was modified
  let anyChanged = false;

  const entries: Array<readonly [string, unknown]> = [];

  for (const key of keys) {
    const result = walk(
      obj[key],
      rules,
      location,
      onSanitization,
      maxDepth,
      depth + 1,
      maxContentLength,
    );
    if (result.blocked) {
      anyBlocked = true;
    }
    if (result.events.length > 0) {
      anyChanged = true;
      allEvents.push(...result.events);
    }
    entries.push([key, result.value] as const);
  }

  if (!anyChanged) {
    return { value, blocked: anyBlocked, events: allEvents };
  }

  const newObj: Record<string, unknown> = {};
  for (const [key, val] of entries) {
    newObj[key] = val;
  }
  return { value: newObj, blocked: anyBlocked, events: allEvents };
}
