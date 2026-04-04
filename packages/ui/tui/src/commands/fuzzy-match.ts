/**
 * Subsequence fuzzy scorer — pure functions, no dependencies.
 *
 * Algorithm: walk the label character by character; advance the query pointer
 * on each match. A match is found only if all query characters appear (in order)
 * within the label. Consecutive matches earn a bonus so "cl" scores "clear"
 * higher than "c...l..." patterns.
 */

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

/**
 * Score a label against a query using subsequence matching.
 *
 * - Returns 0 for no match (query chars do not appear in order in label).
 * - Returns a positive integer for a match; higher = better.
 * - Empty query matches everything and returns 1.
 * - Case-insensitive.
 */
export function fuzzyScore(label: string, query: string): number {
  if (query.length === 0) return 1;

  const lbl = label.toLowerCase();
  const qry = query.toLowerCase();

  if (qry.length > lbl.length) return 0;

  let lblIdx = 0;
  let qryIdx = 0;
  let score = 0;
  let consecutiveBonus = 0;

  while (lblIdx < lbl.length && qryIdx < qry.length) {
    if (lbl[lblIdx] === qry[qryIdx]) {
      // Earlier matches score higher (reward low lblIdx), consecutive matches bonus
      score += 1 + consecutiveBonus;
      consecutiveBonus += 1;
      qryIdx++;
    } else {
      consecutiveBonus = 0;
    }
    lblIdx++;
  }

  // All query characters must be matched
  return qryIdx === qry.length ? score : 0;
}

// ---------------------------------------------------------------------------
// Filter + rank
// ---------------------------------------------------------------------------

/**
 * Filter and rank items by fuzzy match score.
 *
 * Items with score 0 (no subsequence match) are excluded.
 * Remaining items are returned sorted by score descending (best match first).
 * Empty query returns all items unchanged.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getLabel: (item: T) => string,
): readonly T[] {
  if (query.length === 0) return items;

  type Scored = { readonly item: T; readonly score: number };

  const scored: Scored[] = [];
  for (const item of items) {
    const score = fuzzyScore(getLabel(item), query);
    if (score > 0) scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ item }) => item);
}
