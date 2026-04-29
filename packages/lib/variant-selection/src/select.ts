/**
 * Dispatcher — routes to the correct selection strategy.
 */

import type { SelectionStrategy } from "@koi/core";
import { selectByContext } from "./select-by-context.js";
import { selectByFitness } from "./select-by-fitness.js";
import { selectByThompson, type ThompsonStates } from "./select-by-thompson.js";
import { selectRandom } from "./select-random.js";
import { type RoundRobinState, selectRoundRobin } from "./select-round-robin.js";
import type {
  BreakerMap,
  ContextMatcher,
  SelectionContext,
  VariantPool,
  VariantSelection,
} from "./types.js";

export interface SelectVariantOptions<T> {
  readonly pool: VariantPool<T>;
  readonly breakers: BreakerMap;
  readonly strategy: SelectionStrategy;
  readonly ctx: SelectionContext;
  readonly roundRobinState?: RoundRobinState;
  readonly contextMatcher?: ContextMatcher<T>;
  readonly thompsonStates?: ThompsonStates;
}

export function selectVariant<T>(options: SelectVariantOptions<T>): VariantSelection<T> {
  const { pool, breakers, strategy, ctx } = options;

  switch (strategy) {
    case "fitness":
      return selectByFitness(pool, breakers, ctx);
    case "round-robin": {
      const state = options.roundRobinState ?? { index: 0 };
      return selectRoundRobin(pool, breakers, state);
    }
    case "context-match": {
      const matcher = options.contextMatcher ?? (() => 0);
      return selectByContext(pool, breakers, matcher, ctx);
    }
    case "random":
      return selectRandom(pool, breakers, ctx);
    case "thompson": {
      const states = options.thompsonStates ?? new Map();
      return selectByThompson(pool, breakers, states, ctx);
    }
    default: {
      const _exhaustive: never = strategy;
      return { ok: false, reason: `Unknown strategy: ${String(_exhaustive)}` };
    }
  }
}
