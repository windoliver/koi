/**
 * TuiStore — SolidJS store-backed state management.
 *
 * Uses `createStore()` from `solid-js/store` for fine-grained reactivity.
 * Each mutation via `produce()` only triggers signals for the specific
 * properties that changed — text_delta only fires the text signal on
 * one block, not the entire messages array.
 *
 * External API unchanged: getState/dispatch/dispatchBatch/subscribe.
 * getState() returns the reactive proxy — reads inside Solid tracking
 * scopes (createMemo, createEffect) are automatically tracked.
 */

import { createStore as createSolidStore, produce } from "solid-js/store";
import { mutate } from "./mutations.js";
import type { TuiAction, TuiState } from "./types.js";

/** Listener callback — notified when state changes. */
export type StateListener = () => void;

/** Minimal store API — same interface as the previous reducer-based store. */
export interface TuiStore {
  /** Returns the reactive proxy. Reads inside Solid scopes are tracked. */
  readonly getState: () => TuiState;
  readonly dispatch: (action: TuiAction) => void;
  /**
   * Apply an array of actions in one produce() call and notify listeners once.
   * Used by EventBatcher to coalesce batched events.
   */
  readonly dispatchBatch: (actions: readonly TuiAction[]) => void;
  /** Subscribe to state changes. Returns an unsubscribe function. */
  readonly subscribe: (listener: StateListener) => () => void;
}

/** Create a TuiStore backed by SolidJS fine-grained reactive store. */
export function createStore(initialState: TuiState): TuiStore {
  const [state, setState] = createSolidStore(initialState);
  const listeners = new Set<StateListener>();

  // `let` justified: mutable flag for microtask-batched notification coalescing
  let pendingNotify = false;

  function notifySubscribers(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (e: unknown) {
        console.error("TuiStore listener threw:", e);
      }
    }
  }

  function scheduleNotify(): void {
    if (listeners.size === 0) return;
    if (!pendingNotify) {
      pendingNotify = true;
      queueMicrotask(() => {
        pendingNotify = false;
        notifySubscribers();
      });
    }
  }

  function dispatch(action: TuiAction): void {
    setState(produce((draft) => mutate(draft as TuiState, action)));
    scheduleNotify();
  }

  function dispatchBatch(actions: readonly TuiAction[]): void {
    if (actions.length === 0) return;
    setState(
      produce((draft) => {
        for (const action of actions) {
          mutate(draft as TuiState, action);
        }
      }),
    );
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
