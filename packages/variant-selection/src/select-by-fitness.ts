/**
 * Fitness-based variant selection — weighted random by fitness score.
 *
 * Higher fitness score = higher probability of selection.
 * Open circuit breakers are skipped unless all are open (graceful degradation).
 */

import type {
  BreakerMap,
  SelectionContext,
  VariantEntry,
  VariantPool,
  VariantSelection,
} from "./types.js";

/** Filters variants to those with non-open circuit breakers. */
function filterAvailable<T>(
  variants: readonly VariantEntry<T>[],
  breakers: BreakerMap,
): readonly VariantEntry<T>[] {
  const available = variants.filter((v) => {
    const breaker = breakers.get(v.id);
    return breaker === undefined || breaker.isAllowed();
  });
  // Graceful degradation: if all breakers are open, try all variants anyway
  return available.length > 0 ? available : variants;
}

/** Weighted random pick from candidates by fitness score. */
function weightedPick<T>(
  candidates: readonly VariantEntry<T>[],
  random: () => number,
): VariantEntry<T> | undefined {
  const first = candidates[0];
  if (first === undefined) return undefined;
  if (candidates.length === 1) return first;

  const totalWeight = candidates.reduce((sum, v) => sum + Math.max(v.fitnessScore, 0.01), 0);
  const roll = random() * totalWeight;

  let cumulative = 0;
  for (const variant of candidates) {
    cumulative += Math.max(variant.fitnessScore, 0.01);
    if (roll <= cumulative) return variant;
  }

  // Floating point edge case — return last
  return candidates[candidates.length - 1];
}

export function selectByFitness<T>(
  pool: VariantPool<T>,
  breakers: BreakerMap,
  ctx: SelectionContext,
): VariantSelection<T> {
  const available = filterAvailable(pool.variants, breakers);
  if (available.length === 0) {
    return { ok: false, reason: "No variants in pool" };
  }

  const selected = weightedPick(available, ctx.random);
  if (selected === undefined) {
    return { ok: false, reason: "No variants in pool" };
  }

  const alternatives = available.filter((v) => v.id !== selected.id);
  return { ok: true, selected, alternatives };
}
