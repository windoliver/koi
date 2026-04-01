/**
 * Select combinator — subscribe to a derived slice of a ConfigStore.
 *
 * Only fires the listener when the selected value actually changes (by reference).
 */

import type { ConfigListener, ConfigStore, ConfigUnsubscribe } from "@koi/core";

/**
 * Subscribes to a derived slice of `store`. The `listener` is only called
 * when `selector(next) !== selector(prev)` (reference equality).
 *
 * @param store - The source config store.
 * @param selector - Pure function that extracts a slice from the config.
 * @param listener - Callback receiving `(nextSlice, prevSlice)`.
 * @returns Unsubscribe function.
 */
export function selectConfig<T, S>(
  store: ConfigStore<T>,
  selector: (config: T) => S,
  listener: ConfigListener<S>,
): ConfigUnsubscribe {
  return store.subscribe((next, prev) => {
    const nextSlice = selector(next);
    const prevSlice = selector(prev);
    if (nextSlice !== prevSlice) {
      listener(nextSlice, prevSlice);
    }
  });
}
