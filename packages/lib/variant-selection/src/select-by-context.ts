/**
 * Context-match variant selection — user-provided matcher ranks variants.
 *
 * The matcher function scores each variant against the input context.
 * Highest score wins. Ties broken by fitness score.
 */

import type {
  BreakerMap,
  ContextMatcher,
  SelectionContext,
  VariantEntry,
  VariantPool,
  VariantSelection,
} from "./types.js";

export function selectByContext<T>(
  pool: VariantPool<T>,
  breakers: BreakerMap,
  matcher: ContextMatcher<T>,
  ctx: SelectionContext,
): VariantSelection<T> {
  const { variants } = pool;
  if (variants.length === 0) {
    return { ok: false, reason: "No variants in pool" };
  }

  // Filter to available variants (non-open breakers)
  const available = variants.filter((v) => {
    const breaker = breakers.get(v.id);
    return breaker === undefined || breaker.isAllowed();
  });

  // Graceful degradation
  const candidates = available.length > 0 ? available : variants;

  // Score each candidate
  const scored: readonly (readonly [VariantEntry<T>, number])[] = candidates.map(
    (v) => [v, matcher(v, ctx.input)] as const,
  );

  // Sort by matcher score desc, then fitness desc for tie-breaking
  const sorted = [...scored].sort((a, b) => {
    const scoreDiff = b[1] - a[1];
    if (scoreDiff !== 0) return scoreDiff;
    return b[0].fitnessScore - a[0].fitnessScore;
  });

  const best = sorted[0];
  if (best === undefined) {
    return { ok: false, reason: "No variants in pool" };
  }

  const selected = best[0];
  const alternatives = candidates.filter((v) => v.id !== selected.id);
  return { ok: true, selected, alternatives };
}
