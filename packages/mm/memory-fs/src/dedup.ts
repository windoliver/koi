/**
 * Jaccard similarity for memory deduplication.
 *
 * Uses word tokens for Latin text, character bigrams for CJK scripts.
 * Ported from archive/v1/packages/mm/memory-fs/src/dedup.ts.
 */

import type { MemoryRecord, MemoryRecordId } from "@koi/core/memory";

const CJK_PATTERN = /[\u3000-\u9fff\uac00-\ud7af]/;

/** Tokenize text into a set of comparable tokens. */
export function tokenize(text: string): ReadonlySet<string> {
  if (CJK_PATTERN.test(text)) {
    return charBigrams(text);
  }
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return new Set(words);
}

function charBigrams(text: string): ReadonlySet<string> {
  const chars = [...text.toLowerCase().replace(/\s+/g, "")];
  if (chars.length < 2) return new Set(chars);
  const bigrams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) {
    bigrams.add(`${chars[i]}${chars[i + 1]}`);
  }
  return bigrams;
}

/** Compute Jaccard similarity between two strings. */
export function jaccard(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  // let — mutable counter for intersection size
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** Match result from findDuplicate. */
export interface DuplicateMatch {
  readonly id: MemoryRecordId;
  readonly record: MemoryRecord;
  readonly similarity: number;
}

/**
 * Find the most similar existing record above the given threshold.
 * Returns undefined if no duplicate found.
 */
export function findDuplicate(
  content: string,
  existing: readonly MemoryRecord[],
  threshold: number,
): DuplicateMatch | undefined {
  // let — tracking best match across iterations
  let best: DuplicateMatch | undefined;

  for (const record of existing) {
    const sim = jaccard(content, record.content);
    if (sim >= threshold && (best === undefined || sim > best.similarity)) {
      best = { id: record.id, record, similarity: sim };
    }
  }

  return best;
}
