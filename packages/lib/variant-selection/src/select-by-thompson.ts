/**
 * Thompson sampling variant selection — Bayesian exploration/exploitation.
 *
 * Each variant maintains a Beta(α, β) posterior distribution.
 * On each selection: sample from each variant's posterior, pick the highest sample.
 * Updates are immutable: updateThompson() returns a new state object.
 */

import type {
  BreakerMap,
  SelectionContext,
  VariantEntry,
  VariantPool,
  VariantSelection,
} from "./types.js";

/**
 * Beta distribution posterior state for a single variant.
 *
 * α = successes + 1 (prior), β = failures + 1 (prior).
 * Starts at α=1, β=1 (uniform prior — no preference).
 */
export interface ThompsonState {
  readonly alpha: number;
  readonly beta: number;
}

/** Maps variant IDs to their Thompson sampling state. */
export type ThompsonStates = ReadonlyMap<string, ThompsonState>;

/** Create a fresh uniform prior: Beta(1, 1). */
export function createThompsonState(): ThompsonState {
  return { alpha: 1, beta: 1 };
}

/** Immutably update the posterior after observing a result. */
export function updateThompson(state: ThompsonState, success: boolean): ThompsonState {
  return success
    ? { alpha: state.alpha + 1, beta: state.beta }
    : { alpha: state.alpha, beta: state.beta + 1 };
}

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

// ---------------------------------------------------------------------------
// Beta distribution sampling via Gamma variates
// Marsaglia & Tsang (2000) for Gamma, Box-Muller for Normal
// ---------------------------------------------------------------------------

/** Sample from Normal(0, 1) using Box-Muller transform. */
function sampleNormal(random: () => number): number {
  const u1 = Math.max(random(), 1e-10); // avoid log(0)
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Sample from Gamma(alpha, 1) using Marsaglia & Tsang (2000). */
function sampleGamma(alpha: number, random: () => number): number {
  if (alpha < 1) {
    // Ahrens-Dieter reduction: Gamma(α) = Gamma(α+1) × U^(1/α)
    return sampleGamma(alpha + 1, random) * random() ** (1 / alpha);
  }

  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(random);
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Sample from Beta(alpha, beta) using two independent Gamma variates. */
function sampleBeta(alpha: number, beta: number, random: () => number): number {
  const x = sampleGamma(alpha, random);
  const y = sampleGamma(beta, random);
  if (x + y === 0) return 0.5; // degenerate case safety
  return x / (x + y);
}

/**
 * Thompson sampling selection.
 *
 * For each available variant, draw a sample from its Beta(α, β) posterior.
 * Select the variant with the highest drawn sample.
 * Variants without a state entry use the uniform prior Beta(1, 1).
 */
export function selectByThompson<T>(
  pool: VariantPool<T>,
  breakers: BreakerMap,
  states: ThompsonStates,
  ctx: SelectionContext,
): VariantSelection<T> {
  const available = filterAvailable(pool.variants, breakers);
  if (available.length === 0) {
    return { ok: false, reason: "No variants in pool" };
  }

  const first = available[0];
  if (first === undefined) {
    return { ok: false, reason: "No variants in pool" };
  }

  if (available.length === 1) {
    return { ok: true, selected: first, alternatives: [] };
  }

  // Draw from each variant's posterior and pick the highest sample
  let bestSample = -1;
  let bestVariant: VariantEntry<T> = first;
  for (const variant of available) {
    const state = states.get(variant.id) ?? createThompsonState();
    const sample = sampleBeta(state.alpha, state.beta, ctx.random);
    if (sample > bestSample) {
      bestSample = sample;
      bestVariant = variant;
    }
  }

  const alternatives = available.filter((v) => v.id !== bestVariant.id);
  return { ok: true, selected: bestVariant, alternatives };
}
