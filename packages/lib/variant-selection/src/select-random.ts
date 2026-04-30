/**
 * Random variant selection — uniform random from non-broken variants.
 *
 * Used for A/B testing where each variant should get equal traffic.
 */

import type { BreakerMap, SelectionContext, VariantPool, VariantSelection } from "./types.js";

export function selectRandom<T>(
  pool: VariantPool<T>,
  breakers: BreakerMap,
  ctx: SelectionContext,
): VariantSelection<T> {
  const { variants } = pool;
  if (variants.length === 0) {
    return { ok: false, reason: "No variants in pool" };
  }

  // Filter to available variants
  const available = variants.filter((v) => {
    const breaker = breakers.get(v.id);
    return breaker === undefined || breaker.isAllowed();
  });

  // Graceful degradation
  const candidates = available.length > 0 ? available : variants;

  const idx = Math.floor(ctx.random() * candidates.length);
  const selected = candidates[idx];
  if (selected === undefined) {
    return { ok: false, reason: "No variants in pool" };
  }

  const alternatives = candidates.filter((v) => v.id !== selected.id);
  return { ok: true, selected, alternatives };
}
