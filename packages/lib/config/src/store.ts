/**
 * Reactive config store — frozen snapshots with synchronous subscriber notification.
 */

import type { ConfigListener, ConfigStore, ConfigUnsubscribe } from "@koi/core/config";

/**
 * A ConfigStore with a `set()` method for updating the value.
 */
export interface WritableConfigStore<T> extends ConfigStore<T> {
  /** Replaces the current config snapshot, freezes it, and notifies all subscribers synchronously. */
  readonly set: (next: T) => void;
}

/**
 * Creates a reactive config store.
 *
 * - Every value stored is `Object.freeze()`d (shallow).
 * - `get()` is O(1), returning the cached frozen reference.
 * - `subscribe()` fires synchronously on each `set()`.
 */
export function createConfigStore<T extends object>(initial: T): WritableConfigStore<T> {
  let current: T = Object.freeze({ ...initial }) as T;
  const listeners: Set<ConfigListener<T>> = new Set();

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
