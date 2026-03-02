/**
 * Trail strength — pure functions for stigmergic trail decay and reinforcement.
 *
 * Implements MMAS (Max-Min Ant System) bounded exponential decay:
 * - Decay: max(tauMin, stored × e^(-λ × elapsed)) where λ = ln(2) / halfLife
 * - Reinforcement: min(tauMax, current + reinforcement)
 *
 * All functions are pure — no side effects, no I/O.
 */

import type { TrailConfig } from "@koi/core";
import { DEFAULT_TRAIL_CONFIG } from "@koi/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes the effective trail strength after exponential decay over elapsed time.
 *
 * Formula: max(tauMin, storedStrength × e^(-λ × elapsedMs))
 * where λ = ln(2) / (halfLifeDays × MS_PER_DAY)
 *
 * Guards against NaN/Infinity by clamping to [tauMin, tauMax].
 */
export function computeEffectiveTrailStrength(
  storedStrength: number,
  elapsedMs: number,
  config?: Partial<TrailConfig>,
): number {
  const c = resolveConfig(config);

  // Guard: non-positive elapsed = no decay
  if (elapsedMs <= 0) {
    return clamp(storedStrength, c.tauMin, c.tauMax);
  }

  const halfLifeMs = c.halfLifeDays * MS_PER_DAY;
  // Guard: zero or negative half-life makes decay undefined
  if (halfLifeMs <= 0) {
    return c.tauMin;
  }

  const lambda = Math.LN2 / halfLifeMs;
  const decayed = storedStrength * Math.exp(-lambda * elapsedMs);

  // Guard NaN/Infinity from extreme inputs
  if (!Number.isFinite(decayed)) {
    return c.tauMin;
  }

  return Math.max(c.tauMin, Math.min(c.tauMax, decayed));
}

/**
 * Computes the new trail strength after additive reinforcement.
 *
 * Formula: min(tauMax, currentStrength + reinforcement)
 */
export function computeTrailReinforcement(
  currentStrength: number,
  config?: Partial<TrailConfig>,
): number {
  const c = resolveConfig(config);
  const reinforced = currentStrength + c.reinforcement;

  // Guard NaN/Infinity
  if (!Number.isFinite(reinforced)) {
    return c.tauMax;
  }

  return Math.min(c.tauMax, Math.max(c.tauMin, reinforced));
}

/**
 * Returns true when the effective trail strength has decayed to or below tauMin.
 */
export function isTrailEvaporated(
  storedStrength: number,
  elapsedMs: number,
  config?: Partial<TrailConfig>,
): boolean {
  const c = resolveConfig(config);
  const effective = computeEffectiveTrailStrength(storedStrength, elapsedMs, c);
  return effective <= c.tauMin;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function resolveConfig(partial?: Partial<TrailConfig>): TrailConfig {
  if (partial === undefined) return DEFAULT_TRAIL_CONFIG;
  return {
    evaporationRate: partial.evaporationRate ?? DEFAULT_TRAIL_CONFIG.evaporationRate,
    reinforcement: partial.reinforcement ?? DEFAULT_TRAIL_CONFIG.reinforcement,
    tauMin: partial.tauMin ?? DEFAULT_TRAIL_CONFIG.tauMin,
    tauMax: partial.tauMax ?? DEFAULT_TRAIL_CONFIG.tauMax,
    halfLifeDays: partial.halfLifeDays ?? DEFAULT_TRAIL_CONFIG.halfLifeDays,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
