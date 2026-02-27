/**
 * Listener set utility for onChange event dispatch.
 *
 * Creates a typed listener set with add/remove/notify operations.
 * Listeners are called synchronously. Individual listener errors
 * are caught so one broken listener cannot block others.
 */

export interface ListenerSet<E> {
  /** Add a listener. Returns unsubscribe function. */
  readonly add: (listener: (event: E) => void) => () => void;
  /** Notify all listeners of an event. */
  readonly notify: (event: E) => void;
  /** Remove all listeners. */
  readonly clear: () => void;
}

/** Create a new listener set for events of type E. */
export function createListenerSet<E>(): ListenerSet<E> {
  const listeners = new Set<(event: E) => void>();

  const add = (listener: (event: E) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const notify = (event: E): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (_e: unknown) {
        // Intentional: individual listener errors must not block other listeners
        // or the mutation path. Callers providing listeners are responsible for
        // their own error handling within the listener callback.
      }
    }
  };

  const clear = (): void => {
    listeners.clear();
  };

  return { add, notify, clear };
}
