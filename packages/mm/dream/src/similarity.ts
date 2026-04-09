/**
 * Default similarity function — word-level Jaccard index.
 *
 * Simple word tokenization (split on whitespace + punctuation).
 * For CJK-aware tokenization, inject a custom SimilarityFn from @koi/memory-fs.
 */

import type { SimilarityFn } from "./types.js";

/** Tokenizes text into lowercase words. */
function tokenize(text: string): ReadonlySet<string> {
  const words = text.toLowerCase().match(/\p{L}+/gu);
  return new Set(words ?? []);
}

/**
 * Computes Jaccard similarity between two strings.
 * Returns [0, 1] where 1 = identical word sets, 0 = no overlap.
 */
export function jaccard(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  // let justified: counter for intersection size
  let intersectionSize = 0;
  for (const word of setA) {
    if (setB.has(word)) {
      intersectionSize += 1;
    }
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0.0 : intersectionSize / unionSize;
}

/** Default similarity function for dream consolidation. */
export const defaultSimilarity: SimilarityFn = jaccard;
