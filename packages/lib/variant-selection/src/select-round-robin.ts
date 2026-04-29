/**
 * Round-robin variant selection — deterministic rotation.
 *
 * Open circuit breakers are skipped. State is a mutable counter held by the caller.
 */

import type { BreakerMap, VariantPool, VariantSelection } from "./types.js";

/** Encapsulated mutable round-robin state. */
export interface RoundRobinState {
  /** Current index counter. Mutated on each selection. */
  index: number;
}

export function createRoundRobinState(): RoundRobinState {
  return { index: 0 };
}

export function selectRoundRobin<T>(
  pool: VariantPool<T>,
  breakers: BreakerMap,
  state: RoundRobinState,
): VariantSelection<T> {
  const { variants } = pool;
  if (variants.length === 0) {
    return { ok: false, reason: "No variants in pool" };
  }

  // Try each variant starting from current index, skip open breakers
  for (let i = 0; i < variants.length; i++) {
    const idx = (state.index + i) % variants.length;
    const variant = variants[idx];
    if (variant === undefined) continue;

    const breaker = breakers.get(variant.id);
    if (breaker !== undefined && !breaker.isAllowed()) continue;

    // Advance past the selected variant for next call
    state.index = (idx + 1) % variants.length;
    const alternatives = variants.filter((v) => v.id !== variant.id);
    return { ok: true, selected: variant, alternatives };
  }

  // All breakers open — graceful degradation: pick next anyway
  const idx = state.index % variants.length;
  const fallback = variants[idx];
  if (fallback === undefined) {
    return { ok: false, reason: "No variants in pool" };
  }
  state.index = (idx + 1) % variants.length;
  const alternatives = variants.filter((v) => v.id !== fallback.id);
  return { ok: true, selected: fallback, alternatives };
}
