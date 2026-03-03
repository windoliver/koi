/**
 * Defensive listener set utility.
 *
 * Provides a safe notification mechanism where listener errors are swallowed
 * to prevent mutation return paths from being broken. All Nexus store
 * implementations should use this instead of raw Set<fn> + manual try/catch.
 */

/** A set of listeners with safe notification and cleanup. */
export interface ListenerSet<T> {
  /** Notify all listeners. Listener errors are swallowed. */
  readonly notify: (event: T) => void;
  /** Subscribe a listener. Returns an unsubscribe function. */
  readonly subscribe: (fn: (event: T) => void) => () => void;
  /** Current number of active listeners. */
  readonly size: () => number;
}

/** Create a defensive listener set that swallows listener errors. */
export function createListenerSet<T>(): ListenerSet<T> {
  const listeners = new Set<(event: T) => void>();

  const notify = (event: T): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (_err: unknown) {
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
