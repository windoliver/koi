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
 *
 * Returns:
 *   - `0`   when sets are identical and non-empty,
 *   - `1`   when sets are fully disjoint,
 *   - `NaN` when either side is empty (no lexical signal).
 *
 * Returning `NaN` for empty input is deliberate: previously the empty/empty
 * case returned `0`, which the detector then read as "perfect match" and
 * suppressed real drift on terse or acronym-heavy descriptions. Callers
 * should treat `NaN` as "insufficient signal — quarantine this observation"
 * rather than as drift evidence.
 */
export function computeJaccardDistance(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return Number.NaN;

  // let: intersection accumulator
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return 1 - intersection / union;
}
