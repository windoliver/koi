/**
 * Welford's online algorithm for running mean and variance.
 *
 * O(1) space, O(1) per update. No array growth.
 * Reference: https://en.wikipedia.org/wiki/Algorithms_for_calculating_variance#Welford's_online_algorithm
 */

export interface WelfordState {
  readonly count: number;
  readonly mean: number;
  /** Sum of squared deviations from mean. */
  readonly m2: number;
}

export const WELFORD_INITIAL: WelfordState = {
  count: 0,
  mean: 0,
  m2: 0,
};

/**
 * Returns a new WelfordState after incorporating `value`.
 */
export function welfordUpdate(state: WelfordState, value: number): WelfordState {
  const count = state.count + 1;
  const delta = value - state.mean;
  const mean = state.mean + delta / count;
  const delta2 = value - mean;
  const m2 = state.m2 + delta * delta2;
  return { count, mean, m2 };
}

/**
 * Returns the population standard deviation from WelfordState.
 * Returns 0 if count < 2 (insufficient data).
 */
export function welfordStddev(state: WelfordState): number {
  if (state.count < 2) return 0;
  return Math.sqrt(state.m2 / state.count);
}
