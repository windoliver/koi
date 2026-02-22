/**
 * Reactive config store — get() + subscribe() with synchronous notifications.
 *
 * - get() returns a cached, shallow-frozen reference (O(1), zero allocation).
 * - subscribe() fires synchronously when set() is called.
 * - set() shallow-freezes the new value before storing.
 */

import type { ConfigListener, ConfigStore, ConfigUnsubscribe } from "@koi/core";

export interface WritableConfigStore<T> extends ConfigStore<T> {
  /** Replace the current config snapshot. Notifies all subscribers synchronously. */
  readonly set: (next: T) => void;
}

/**
 * Creates a writable reactive config store.
 *
 * @param initial - The initial config value (will be shallow-frozen).
 */
export function createConfigStore<T extends object>(initial: T): WritableConfigStore<T> {
  let current: T = Object.freeze({ ...initial }) as T;
  const listeners = new Set<ConfigListener<T>>();

  const get = (): T => current;

  const subscribe = (listener: ConfigListener<T>): ConfigUnsubscribe => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const set = (next: T): void => {
    const prev = current;
    current = Object.freeze({ ...next }) as T;
    for (const listener of listeners) {
      listener(current, prev);
    }
  };

  return { get, subscribe, set };
}
