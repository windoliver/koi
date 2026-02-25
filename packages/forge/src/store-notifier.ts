/**
 * In-memory store change notifier — pub/sub for cross-agent cache invalidation.
 *
 * Sync-only (in-process). Async backends (Redis, Nexus) would be separate L2 packages.
 */

import type { StoreChangeEvent, StoreChangeNotifier } from "@koi/core";

/** Safety cap — catches leaked listeners before they accumulate unboundedly. */
const MAX_SUBSCRIBERS = 64;

/**
 * Creates an in-memory `StoreChangeNotifier` backed by a simple listener map.
 *
 * - `notify()` snapshots the listener array and calls each synchronously.
 * - `subscribe()` returns an unsubscribe function.
 * - Throws if subscriber count reaches `MAX_SUBSCRIBERS` (likely a leak).
 */
export function createMemoryStoreChangeNotifier(): StoreChangeNotifier {
  let nextId = 0;
  const listeners = new Map<number, (event: StoreChangeEvent) => void>();

  const notify = (event: StoreChangeEvent): void => {
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

  const subscribe = (listener: (event: StoreChangeEvent) => void): (() => void) => {
    if (listeners.size >= MAX_SUBSCRIBERS) {
      throw new Error(
        `StoreChangeNotifier: subscriber limit (${String(MAX_SUBSCRIBERS)}) reached — likely a listener leak. ` +
          `Ensure dispose()/unsubscribe() is called when providers are torn down.`,
      );
    }
    const id = nextId++;
    listeners.set(id, listener);
    return (): void => {
      listeners.delete(id);
    };
  };

  return { notify, subscribe };
}
