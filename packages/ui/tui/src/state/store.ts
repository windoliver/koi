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

  function getState(): TuiState {
    return state;
  }

  function subscribe(listener: StateListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { getState, dispatch, subscribe };
}
