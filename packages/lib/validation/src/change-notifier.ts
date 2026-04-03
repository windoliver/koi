/**
 * Generic in-memory change notifier — pub/sub for mutation observation.
 *
 * Extracted to @koi/validation (L0u) so all store implementations can
 * reuse the same notification pattern without cross-L2 imports.
 *
 * Features:
 * - Subscriber cap (catches leaked listeners)
 * - Snapshot-before-iterate (safe if listener unsubscribes during notification)
 * - Idempotent unsubscribe
 * - Error isolation (one listener throwing doesn't break others)
 */

import type { ChangeNotifier } from "@koi/core";

/** Safety cap — catches leaked listeners before they accumulate unboundedly. */
const MAX_SUBSCRIBERS = 64;

/**
 * Creates an in-memory `ChangeNotifier<E>` backed by a simple listener map.
 *
 * - `notify()` snapshots the listener array and calls each synchronously.
 * - `subscribe()` returns an idempotent unsubscribe function.
 * - Throws if subscriber count reaches `MAX_SUBSCRIBERS` (likely a leak).
 */
export function createMemoryChangeNotifier<E>(): ChangeNotifier<E> {
  let nextId = 0;
  const listeners = new Map<number, (event: E) => void>();

  const notify = (event: E): void => {
    // Snapshot to avoid issues if a listener unsubscribes during iteration
    const snapshot = [...listeners.values()];
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch (_: unknown) {
        // Never let one listener break others — silently continue
      }
    }
  };

  const subscribe = (listener: (event: E) => void): (() => void) => {
    if (listeners.size >= MAX_SUBSCRIBERS) {
      throw new Error(
        `ChangeNotifier: subscriber limit (${String(MAX_SUBSCRIBERS)}) reached — likely a listener leak. ` +
          `Ensure dispose()/unsubscribe() is called when providers are torn down.`,
      );
    }
    const id = nextId++;
    listeners.set(id, listener);
    let removed = false;
    return (): void => {
      if (removed) return;
      removed = true;
      listeners.delete(id);
    };
  };

  return { notify, subscribe };
}
