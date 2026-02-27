/**
 * Jaccard similarity for deduplication.
 *
 * Uses word tokens for Latin text, character bigrams for CJK scripts.
 */

const CJK_PATTERN = /[\u3000-\u9fff\uac00-\ud7af]/;

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

export function jaccard(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  // let — needed for mutable counter
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}
