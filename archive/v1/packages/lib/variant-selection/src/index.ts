/**
 * @koi/variant-selection — Selection strategies for degenerate tool variants.
 *
 * L0u utility package. Depends on @koi/core, @koi/errors, @koi/validation.
 */

export {
  type AllFailedError,
  type ExecuteWithFailoverOptions,
  executeWithFailover,
  type FailoverOutcome,
  type FailoverResult,
} from "./execute-with-failover.js";
export { type SelectVariantOptions, selectVariant } from "./select.js";
export { selectByContext } from "./select-by-context.js";
export { selectByFitness } from "./select-by-fitness.js";
export {
  createThompsonState,
  selectByThompson,
  type ThompsonState,
  type ThompsonStates,
  updateThompson,
} from "./select-by-thompson.js";
export { selectRandom } from "./select-random.js";
export {
  createRoundRobinState,
  type RoundRobinState,
  selectRoundRobin,
} from "./select-round-robin.js";
export type {
  BreakerMap,
  ContextMatcher,
  SelectionContext,
  VariantEntry,
  VariantPool,
  VariantSelection,
} from "./types.js";
