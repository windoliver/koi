/**
 * Pure tokenization + Jaccard distance for purpose-drift detection.
 * Zero side effects, no state.
 */

const STOPWORDS: ReadonlySet<string> = new Set([
  "and",
  "are",
  "but",
  "for",
  "from",
  "has",
  "have",
  "into",
  "not",
  "the",
  "this",
  "that",
  "those",
  "these",
  "with",
  "was",
  "were",
  "will",
  "would",
  "could",
  "should",
]);

/**
 * Split identifier-shaped text into lowercase keyword tokens.
 *
 * Splits on:
 *   - non-word/underscore boundaries (whitespace, punctuation, `_`),
 *   - camelCase / PascalCase boundaries (`readFile` → `read`, `file`),
 *   - acronym↔word boundaries (`HTTPRequest` → `http`, `request`).
 *
 * Drops stopwords and tokens shorter than 3 chars. Without this, function
 * names and file paths like `read_file`, `readFile`, or `parse_json_config`
 * survive as single opaque tokens and inflate Jaccard divergence between
 * semantically related descriptions.
 */
export function tokenize(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  // Separate at non-word and underscore, then at camelCase / acronym seams.
  const segments = text
    .split(/[^A-Za-z0-9]+|_+/)
    .flatMap((seg) => seg.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/));
  for (const segment of segments) {
    const word = segment.toLowerCase();
    if (word.length >= 3 && !STOPWORDS.has(word)) {
      tokens.add(word);
    }
  }
  return tokens;
}

/**
 * Jaccard distance between two token sets.
 * 0 = identical, 1 = disjoint. Two empty sets return 0 (no signal when no data).
 */
export function computeJaccardDistance(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  // let: intersection accumulator
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return 1 - intersection / union;
}
