/**
 * Shared utilities for event-trace: pickDefined, sumOptional, truncateContent.
 */

import type { RichContent } from "@koi/core/rich-trajectory";

const DEFAULT_MAX_OUTPUT_BYTES = 8192;

/**
 * Strips `undefined` values from an object, returning only defined entries.
 * Used in spread position to conditionally add optional fields:
 *
 *   { required: "value", ...pickDefined({ optional: maybeUndefined }) }
 *
 * Returns `Record<string, unknown>` intentionally — type safety comes from
 * the enclosing object literal's type annotation, not from this function.
 * This avoids `exactOptionalPropertyTypes` conflicts where `T | undefined`
 * cannot be assigned to optional `T?` properties.
 */
export function pickDefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * Sum an optional numeric field across an array of objects.
 * Returns `undefined` when no objects have the field defined (preserves
 * the "no data" vs "zero" distinction for ATIF metrics).
 */
export function sumOptional<T>(
  items: readonly T[],
  accessor: (item: T) => number | undefined,
): number | undefined {
  // let: mutable accumulator for numeric sum
  let total = 0;
  // let: tracks whether any value was found
  let found = false;

  for (const item of items) {
    const value = accessor(item);
    if (value !== undefined) {
      total += value;
      found = true;
    }
  }

  return found ? total : undefined;
}

/**
 * Truncate text content to a maximum UTF-8 byte size, preserving head and tail.
 * Returns a `RichContent` with truncation metadata when content exceeds the limit.
 *
 * Truncates on encoded bytes (not UTF-16 code units) so multibyte Unicode
 * content stays within the byte budget. Avoids splitting in the middle of
 * a multibyte character by walking code points.
 *
 * Strategy: first 50% of budget + "...[truncated]..." + last 50% of budget.
 */
export function truncateContent(
  text: string,
  maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
): RichContent {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);

  if (encoded.length <= maxBytes) {
    return { text };
  }

  const separator = "\n...[truncated]...\n";
  const separatorBytes = encoder.encode(separator).length;
  const availableBytes = maxBytes - separatorBytes;
  const halfBudget = Math.floor(availableBytes / 2);

  // Walk code points to find byte-safe cut points that don't split characters.
  // Head: take characters from the front until we exceed halfBudget bytes.
  const headChars: string[] = [];
  // let: mutable byte counter for head
  let headByteCount = 0;
  for (const char of text) {
    const charBytes = encoder.encode(char).length;
    if (headByteCount + charBytes > halfBudget) break;
    headChars.push(char);
    headByteCount += charBytes;
  }

  // Tail: take characters from the end until we exceed halfBudget bytes.
  const chars = [...text]; // spread into code points
  const tailChars: string[] = [];
  // let: mutable byte counter for tail
  let tailByteCount = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const c = chars[i];
    if (c === undefined) break;
    const charBytes = encoder.encode(c).length;
    if (tailByteCount + charBytes > halfBudget) break;
    tailChars.unshift(c);
    tailByteCount += charBytes;
  }

  return {
    text: `${headChars.join("")}${separator}${tailChars.join("")}`,
    truncated: true,
    originalSize: encoded.length,
  };
}
