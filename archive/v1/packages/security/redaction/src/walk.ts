/**
 * Object walker — immutable copy-on-write traversal with field-name + value scanning.
 */

import { applyCensorToField } from "./censor.js";
import type { FieldMatcher } from "./field-match.js";
import { scanSecrets } from "./scan-string.js";
import type { Censor, RedactObjectResult, SecretPattern } from "./types.js";

/** Keys that must never be traversed to prevent prototype pollution. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Placeholder for circular references. */
const CIRCULAR_PLACEHOLDER = "[Circular]";

interface WalkContext {
  readonly patterns: readonly SecretPattern[];
  readonly fieldMatcher: FieldMatcher;
  readonly censor: Censor;
  readonly fieldCensor: Censor;
  readonly maxDepth: number;
  readonly maxStringLength: number;
}

interface WalkResult {
  readonly value: unknown;
  readonly changed: boolean;
  readonly secretCount: number;
  readonly fieldCount: number;
}

const UNCHANGED_ZERO: Pick<WalkResult, "secretCount" | "fieldCount"> = {
  secretCount: 0,
  fieldCount: 0,
};

function walkValue(
  value: unknown,
  key: string | undefined,
  ctx: WalkContext,
  depth: number,
  seen: WeakSet<object>,
): WalkResult {
  // Depth guard
  if (depth > ctx.maxDepth) {
    return { value, changed: false, ...UNCHANGED_ZERO };
  }

  // Field-name match: censor the entire string value
  if (key !== undefined && typeof value === "string" && ctx.fieldMatcher(key)) {
    const censored = applyCensorToField(value, ctx.fieldCensor, key);
    return {
      value: censored,
      changed: censored !== value,
      secretCount: 0,
      fieldCount: censored !== value ? 1 : 0,
    };
  }

  // String leaf: scan for secrets
  if (typeof value === "string") {
    const result = scanSecrets(value, ctx.patterns, ctx.censor, ctx.maxStringLength);
    return {
      value: result.text,
      changed: result.changed,
      secretCount: result.matchCount,
      fieldCount: 0,
    };
  }

  // Non-object primitives: pass through
  if (value === null || value === undefined || typeof value !== "object") {
    return { value, changed: false, ...UNCHANGED_ZERO };
  }

  // Circular reference detection
  if (seen.has(value)) {
    return { value: CIRCULAR_PLACEHOLDER, changed: true, ...UNCHANGED_ZERO };
  }
  seen.add(value);

  // Array
  if (Array.isArray(value)) {
    return walkArray(value, ctx, depth, seen);
  }

  // Plain object
  return walkObject(value as Record<string, unknown>, ctx, depth, seen);
}

function walkArray(
  arr: readonly unknown[],
  ctx: WalkContext,
  depth: number,
  seen: WeakSet<object>,
): WalkResult {
  // let justified: tracks whether any element was modified
  let anyChanged = false;
  // let justified: accumulates secret count across elements
  let totalSecrets = 0;
  // let justified: accumulates field count across elements
  let totalFields = 0;

  const newArr = arr.map((item) => {
    const result = walkValue(item, undefined, ctx, depth + 1, seen);
    if (result.changed) anyChanged = true;
    totalSecrets += result.secretCount;
    totalFields += result.fieldCount;
    return result.value;
  });

  return {
    value: anyChanged ? newArr : arr,
    changed: anyChanged,
    secretCount: totalSecrets,
    fieldCount: totalFields,
  };
}

function walkObject(
  obj: Record<string, unknown>,
  ctx: WalkContext,
  depth: number,
  seen: WeakSet<object>,
): WalkResult {
  const keys = Object.keys(obj);
  // let justified: tracks whether any field was modified
  let anyChanged = false;
  // let justified: accumulates secret count across fields
  let totalSecrets = 0;
  // let justified: accumulates field count across fields
  let totalFields = 0;
  const entries: Array<readonly [string, unknown]> = [];

  for (const key of keys) {
    // Prototype pollution guard
    if (UNSAFE_KEYS.has(key) || !Object.hasOwn(obj, key)) {
      entries.push([key, obj[key]] as const);
      continue;
    }

    const result = walkValue(obj[key], key, ctx, depth + 1, seen);
    if (result.changed) anyChanged = true;
    totalSecrets += result.secretCount;
    totalFields += result.fieldCount;
    entries.push([key, result.value] as const);
  }

  if (!anyChanged) {
    return { value: obj, changed: false, secretCount: totalSecrets, fieldCount: totalFields };
  }

  const newObj = Object.fromEntries(entries) as Record<string, unknown>;
  return { value: newObj, changed: true, secretCount: totalSecrets, fieldCount: totalFields };
}

/**
 * Walk an object graph, applying field-name matching and secret scanning.
 * Returns an immutable copy-on-write result — only copies nodes that changed.
 */
export function walkAndRedact<T>(value: T, ctx: WalkContext): RedactObjectResult<T> {
  const seen = new WeakSet<object>();
  const result = walkValue(value, undefined, ctx, 0, seen);
  return {
    value: result.value as T,
    changed: result.changed,
    secretCount: result.secretCount,
    fieldCount: result.fieldCount,
  };
}
