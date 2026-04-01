/**
 * Slice subscription with ref-equality skip for config stores.
 */

import type { ConfigStore, ConfigUnsubscribe } from "@koi/core/config";

/**
 * Subscribes to a config store but only fires `listener` when the selected
 * slice changes by reference (===).
 *
 * Returns an unsubscribe function.
 */
export function selectConfig<T, S>(
  store: ConfigStore<T>,
  selector: (config: T) => S,
  listener: (next: S, prev: S) => void,
): ConfigUnsubscribe {
  let previousSlice: S = selector(store.get());

  return store.subscribe((next) => {
    const nextSlice = selector(next);
    if (nextSlice !== previousSlice) {
      const prev = previousSlice;
      previousSlice = nextSlice;
      listener(nextSlice, prev);
    }
  });
}
