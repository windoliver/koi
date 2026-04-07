/**
 * TuiStore — thin wrapper around reduce() for React integration.
 *
 * Matches the useSyncExternalStore contract:
 * - getState() always returns the latest state (never stale)
 * - subscribe(listener) returns an unsubscribe function
 * - dispatch(action) applies reducer synchronously, coalesces notifications via microtask
 */

import { reduce } from "./reduce.js";
import type { TuiAction, TuiState } from "./types.js";

/** Listener callback — notified when state changes. */
export type StateListener = () => void;

/** Minimal store API for useSyncExternalStore integration. */
export interface TuiStore {
  readonly getState: () => TuiState;
  readonly dispatch: (action: TuiAction) => void;
  /**
   * Reduce an array of actions in one pass and notify listeners once.
   * Avoids N state updates + N signal invalidations for batched events
   * (e.g., 10 text_delta events flushed by EventBatcher in one 16ms window).
   */
  readonly dispatchBatch: (actions: readonly TuiAction[]) => void;
  readonly subscribe: (listener: StateListener) => () => void;
}

/** Create a TuiStore wrapping the pure reducer with microtask-batched notifications. */
export function createStore(initialState: TuiState): TuiStore {
  let state = initialState;
  const listeners = new Set<StateListener>();
  let pendingNotify = false;
  let changed = false;

  function notifySubscribers(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (e: unknown) {
        console.error("TuiStore listener threw:", e);
      }
    }
  }

  function dispatch(action: TuiAction): void {
    const next = reduce(state, action);
    if (next === state) return; // no-op guard — skip notification
    state = next;
    changed = true;

    if (!pendingNotify) {
      pendingNotify = true;
      queueMicrotask(() => {
        pendingNotify = false;
        if (changed) {
          changed = false;
          notifySubscribers();
        }
      });
    }
  }

  function dispatchBatch(actions: readonly TuiAction[]): void {
    // Reduce all actions in one pass — O(n) state transitions, 0 notifications
    let current = state;
    for (const action of actions) {
      current = reduce(current, action);
    }
    if (current === state) return; // entire batch was no-ops
    state = current;
    // Notify synchronously — caller (EventBatcher flush) already rate-limits
    notifySubscribers();
  }

  function getState(): TuiState {
    return state;
  }

  function subscribe(listener: StateListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { getState, dispatch, dispatchBatch, subscribe };
}
