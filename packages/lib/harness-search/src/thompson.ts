/**
 * Inlined 2-arm Thompson posterior helpers.
 *
 * Search uses a single bandit (continue vs deploy) — no need for the
 * generalized variant pool / breaker / failover machinery in
 * @koi/variant-selection. The three helpers below are the entire
 * surface needed for binary explore/exploit; keeping them local also
 * removes a workspace dependency that would otherwise have no other
 * runtime consumer.
 */

/** Beta(α, β) posterior. Uniform prior is α=1, β=1. */
export interface ThompsonState {
  readonly alpha: number;
  readonly beta: number;
}

/** Fresh uniform prior: Beta(1, 1). */
export function createThompsonState(): ThompsonState {
  return { alpha: 1, beta: 1 };
}

/** Immutable Bayesian update — success increments α, failure increments β. */
export function updateThompson(state: ThompsonState, success: boolean): ThompsonState {
  return success
    ? { alpha: state.alpha + 1, beta: state.beta }
    : { alpha: state.alpha, beta: state.beta + 1 };
}
