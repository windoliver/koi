/**
 * FileIndex — high-performance fuzzy file search for @-mention completion.
 *
 * Ported from Claude Code's native-ts/file-index (nucleo-style scorer).
 * Key optimizations:
 *   - 26-bit char bitmap per path for O(1) rejection (~90% paths skipped)
 *   - Gap penalties + boundary/camelCase bonuses for better ranking
 *   - Top-k selection avoids sorting all matches
 *   - Pre-computed lowercase paths avoid repeated toLowerCase()
 *   - Smart case: lowercase query = insensitive, any uppercase = sensitive
 */

// ---------------------------------------------------------------------------
// Scoring constants (nucleo/fzf-v2 approximation)
// ---------------------------------------------------------------------------

/** Base score for each matched character. */
const SCORE_MATCH = 16;

/** Bonus when match is at a word boundary (after / \ - _ . space). */
const BONUS_BOUNDARY = 8;

/** Bonus when match is a camelCase transition (lowercase → uppercase). */
const BONUS_CAMEL = 6;

/** Bonus for consecutive matched characters. */
const BONUS_CONSECUTIVE = 4;

/** Bonus when the first needle char matches at position 0. */
const BONUS_FIRST_CHAR = 8;

/** Penalty for starting a gap between matched characters. */
const PENALTY_GAP_START = 3;

/** Penalty per additional character in a gap. */
const PENALTY_GAP_EXTENSION = 1;

/** Maximum query length supported. */
const MAX_QUERY_LEN = 64;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBoundary(code: number): boolean {
  return (
    code === 47 || // /
    code === 92 || // \
    code === 45 || // -
    code === 95 || // _
    code === 46 || // .
    code === 32 // space
  );
}

function isLower(code: number): boolean {
  return code >= 97 && code <= 122;
}

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

/**
 * Boundary/camelCase bonus for a match at `pos` in the original-case path.
 * `first` enables the start-of-string bonus (only for needle[0]).
 */
function scoreBonusAt(path: string, pos: number, first: boolean): number {
  if (pos === 0) return first ? BONUS_FIRST_CHAR : 0;
  const prevCh = path.charCodeAt(pos - 1);
  if (isBoundary(prevCh)) return BONUS_BOUNDARY;
  if (isLower(prevCh) && isUpper(path.charCodeAt(pos))) return BONUS_CAMEL;
  return 0;
}

// Reusable buffer for match positions (avoids allocation per search)
const posBuf = new Int32Array(MAX_QUERY_LEN);

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface SearchResult {
  readonly path: string;
  readonly score: number;
}

// ---------------------------------------------------------------------------
// FileIndex
// ---------------------------------------------------------------------------

export class FileIndex {
  private paths: string[] = [];
  private lowerPaths: string[] = [];
  /** 26-bit a-z character bitmap per path. Bit i set = path contains char (97+i). */
  private charBits: Int32Array = new Int32Array(0);
  private pathLens: Uint16Array = new Uint16Array(0);

  /** Load paths and build the index. Deduplicates input. */
  loadFromFileList(fileList: readonly string[]): void {
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const line of fileList) {
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line);
        paths.push(line);
      }
    }
    this.buildIndex(paths);
  }

  /** Number of indexed paths. */
  get size(): number {
    return this.paths.length;
  }

  /**
   * Search for files matching the query using fuzzy matching.
   * Returns top `limit` results sorted by score descending (best first).
   */
  search(query: string, limit: number): readonly SearchResult[] {
    if (limit <= 0) return [];
    if (query.length === 0) {
      // Empty query: return first `limit` paths with score 0
      return this.paths.slice(0, limit).map((path) => ({ path, score: 0 }));
    }

    // Smart case: lowercase query → case-insensitive; any uppercase → sensitive
    const caseSensitive = query !== query.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const nLen = Math.min(needle.length, MAX_QUERY_LEN);
    const needleChars: string[] = new Array(nLen);
    let needleBitmap = 0;
    for (let j = 0; j < nLen; j++) {
      const ch = needle.charAt(j);
      needleChars[j] = ch;
      const cc = ch.charCodeAt(0);
      if (cc >= 97 && cc <= 122) needleBitmap |= 1 << (cc - 97);
    }

    // Upper bound on score (all boundary bonuses) for gap-bound rejection
    const scoreCeiling = nLen * (SCORE_MATCH + BONUS_BOUNDARY) + BONUS_FIRST_CHAR + 32;

    // Top-k: maintain sorted-ascending array of best `limit` matches
    const topK: { path: string; fuzzScore: number }[] = [];
    let threshold = -Infinity;

    const { paths, lowerPaths, charBits, pathLens } = this;
    const count = paths.length;

    outer: for (let i = 0; i < count; i++) {
      // O(1) bitmap reject: path must contain every a-z letter in the needle
      if ((charBits[i]! & needleBitmap) !== needleBitmap) continue;

      const haystack = caseSensitive ? paths[i]! : lowerPaths[i]!;

      // Fused indexOf scan: find positions + accumulate gap/consecutive terms
      let pos = haystack.indexOf(needleChars[0]!);
      if (pos === -1) continue;
      posBuf[0] = pos;
      let gapPenalty = 0;
      let consecBonus = 0;
      let prev = pos;
      for (let j = 1; j < nLen; j++) {
        pos = haystack.indexOf(needleChars[j]!, prev + 1);
        if (pos === -1) continue outer;
        posBuf[j] = pos;
        const gap = pos - prev - 1;
        if (gap === 0) consecBonus += BONUS_CONSECUTIVE;
        else gapPenalty += PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION;
        prev = pos;
      }

      // Gap-bound reject: skip boundary pass if can't beat threshold
      if (topK.length === limit && scoreCeiling + consecBonus - gapPenalty <= threshold) {
        continue;
      }

      // Boundary/camelCase scoring
      const originalPath = paths[i]!;
      const hLen = pathLens[i]!;
      let score = nLen * SCORE_MATCH + consecBonus - gapPenalty;
      score += scoreBonusAt(originalPath, posBuf[0]!, true);
      for (let j = 1; j < nLen; j++) {
        score += scoreBonusAt(originalPath, posBuf[j]!, false);
      }
      // Length bonus: shorter paths score slightly higher
      score += Math.max(0, 32 - (hLen >> 2));

      // Insert into top-k
      if (topK.length < limit) {
        topK.push({ path: originalPath, fuzzScore: score });
        if (topK.length === limit) {
          topK.sort((a, b) => a.fuzzScore - b.fuzzScore);
          // biome-ignore lint/style/noNonNullAssertion: topK.length === limit > 0
          threshold = topK[0]!.fuzzScore;
        }
      } else if (score > threshold) {
        // Binary search for insertion point
        let lo = 0;
        let hi = topK.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          // biome-ignore lint/style/noNonNullAssertion: mid is in bounds by binary search invariant
          if (topK[mid]!.fuzzScore < score) lo = mid + 1;
          else hi = mid;
        }
        topK.splice(lo, 0, { path: originalPath, fuzzScore: score });
        topK.shift();
        // biome-ignore lint/style/noNonNullAssertion: topK.length === limit > 0 after shift
        threshold = topK[0]!.fuzzScore;
      }
    }

    // Return descending (best first)
    topK.sort((a, b) => b.fuzzScore - a.fuzzScore);
    return topK.map(({ path, fuzzScore }) => ({ path, score: fuzzScore }));
  }

  // ── Internal ────────────────────────────────────────────────────────

  private buildIndex(paths: string[]): void {
    const n = paths.length;
    this.paths = paths;
    this.lowerPaths = new Array(n);
    this.charBits = new Int32Array(n);
    this.pathLens = new Uint16Array(n);

    for (let i = 0; i < n; i++) {
      // biome-ignore lint/style/noNonNullAssertion: i < n = paths.length
      const lp = paths[i]!.toLowerCase();
      this.lowerPaths[i] = lp;
      const len = lp.length;
      this.pathLens[i] = len;
      let bits = 0;
      for (let j = 0; j < len; j++) {
        const c = lp.charCodeAt(j);
        if (c >= 97 && c <= 122) bits |= 1 << (c - 97);
      }
      this.charBits[i] = bits;
    }
  }
}
