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
 * Explicit allowlist of 2-letter tokens to keep. Without this, every
 * 2-character segment survives — including common short English words like
 * `to`, `of`, `in`, `on`, `is`, `it`, `at`, `by` — which then count toward
 * Jaccard overlap and silently reduce divergence between unrelated texts,
 * masking real drift on ordinary prose. Allowlisting recognised technical
 * acronyms keeps the signal we wanted (`db`, `ui`, `ml`, `ci`, …) without
 * pulling in noise.
 */
const TWO_LETTER_ALLOWLIST: ReadonlySet<string> = new Set([
  "ai",
  "ci",
  "cd",
  "cs",
  "db",
  "dx",
  "fs",
  "go",
  "hr",
  "io",
  "ip",
  "js",
  "ml",
  "ms",
  "os",
  "py",
  "qa",
  "rs",
  "s3", // common infra shorthand (object storage)
  "sh",
  "sql",
  "ts",
  "ui",
  "ux",
  "vm",
]);

/**
 * Split identifier-shaped text into lowercase keyword tokens.
 *
 * Splits on:
 *   - non-letter / non-number boundaries (whitespace, punctuation, `_`),
 *   - camelCase / PascalCase boundaries (`readFile` → `read`, `file`),
 *   - acronym↔word boundaries (`HTTPRequest` → `http`, `request`).
 *
 * Unicode-aware: uses `\p{L}` / `\p{N}` so CJK, Cyrillic, Arabic, and other
 * non-Latin scripts produce tokens instead of being silently dropped (the
 * old `[A-Za-z0-9]` split returned empty segments for non-ASCII text and
 * `computeJaccardDistance` returned `NaN`, hiding all such observations).
 *
 * Drops stopwords and tokens shorter than 3 chars by default. 2-letter
 * Latin tokens survive only when allowlisted (`db`, `ui`, `ml`, `ci`, …) —
 * without the allowlist, common 2-char English words like `to`, `of`, `in`,
 * `on`, `is`, `it` would slip through and dilute Jaccard divergence,
 * masking real drift. Length-2 NON-ASCII tokens always survive: in CJK and
 * similar scripts a 2-character word is a normal morpheme, and there is
 * no equivalent stopword problem to suppress.
 */
export function tokenize(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  // Separate at non-letter / non-number and underscore, then at
  // camelCase / acronym seams. The `u` flag makes `\p{L}` / `\p{N}` work.
  const segments = text
    .split(/[^\p{L}\p{N}]+|_+/u)
    .flatMap((seg) => seg.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u));
  for (const segment of segments) {
    const word = segment.toLowerCase();
    if (word.length === 0) continue;
    if (STOPWORDS.has(word)) continue;
    if (isRuntimeIdentifier(word)) continue;
    if (word.length >= 3) {
      tokens.add(word);
    } else if (word.length === 2) {
      if (TWO_LETTER_ALLOWLIST.has(word)) tokens.add(word);
      else if (!isAsciiLatin(word)) tokens.add(word);
    }
  }
  return tokens;
}

/** True when every char is ASCII Latin / digit (no \p{L} outside [a-z0-9]). */
function isAsciiLatin(word: string): boolean {
  return /^[a-z0-9]+$/.test(word);
}

/**
 * Reject runtime-identifier-shaped tokens before they reach the Jaccard
 * sets: digits-only (`200`, `1730000000`), hex digests (`a3f9c2`), and
 * mixed alphanumeric blobs that look like UUID fragments / ticket IDs.
 * These are common in tool/model context but absent from artifact
 * descriptions, so they enlarge the union without contributing real
 * semantic drift and produce false positives under noisy production
 * traffic. Plain technical words (`http`, `tool`, `agent`) keep at least
 * two letter-runs of length ≥ 2 and are unaffected.
 */
function isRuntimeIdentifier(word: string): boolean {
  if (word.length === 0) return false;
  // Digits-only — timestamps, ports, HTTP codes, ticket numbers (Unicode-aware).
  if (/^\p{N}+$/u.test(word)) return true;
  // No digits → not an identifier blob.
  if (!/\p{N}/u.test(word)) return false;
  // Mixed alphanumeric: reject only if at least 6 chars AND no run of ≥3
  // consecutive letters. UUID fragments, hex digests, and base32 IDs are
  // typically ≥ 6 chars; real domain shorthand (`i18n`, `l10n`, `k8s`,
  // `2fa`, `h2x`) is shorter and stays. The 3-letter-run check still keeps
  // `oauth2`, `sha256`, `utf8`, etc. — those have a real letter run.
  if (word.length < 6) return false;
  return !/\p{L}{3,}/u.test(word);
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
