/**
 * Defensive listener set utility.
 *
 * Provides a safe notification mechanism where listener errors are swallowed
 * to prevent mutation return paths from being broken. All Nexus store
 * implementations should use this instead of raw Set<fn> + manual try/catch.
 */

/** Options for configuring a ListenerSet. */
export interface ListenerSetOptions<T> {
  /** Called when a listener throws. If omitted, errors are silently swallowed. */
  readonly onError?: (err: unknown, event: T) => void;
}

/** A set of listeners with safe notification and cleanup. */
export interface ListenerSet<T> {
  /** Notify all listeners. Listener errors are swallowed (or forwarded to onError). */
  readonly notify: (event: T) => void;
  /** Subscribe a listener. Returns an unsubscribe function. */
  readonly subscribe: (fn: (event: T) => void) => () => void;
  /** Current number of active listeners. */
  readonly size: () => number;
}

/** Create a defensive listener set that swallows listener errors. */
export function createListenerSet<T>(options?: ListenerSetOptions<T>): ListenerSet<T> {
  const listeners = new Set<(event: T) => void>();
  const onError = options?.onError;

  const notify = (event: T): void => {
    // Snapshot: guarantees all listeners fire even if one unsubscribes another mid-iteration.
    const snapshot = [...listeners];
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch (err: unknown) {
        if (onError !== undefined) {
          onError(err, event);
        }
        // Listener errors must not break the mutation return path.
      }
    }
  };

  const subscribe = (fn: (event: T) => void): (() => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };

  const size = (): number => listeners.size;

  return { notify, subscribe, size };
}
