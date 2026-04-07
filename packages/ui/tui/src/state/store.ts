/**
 * TuiStore — SolidJS store with reconcile()-based updates.
 *
 * Uses the pure reducer to compute new state, then `reconcile()` to
 * deep-diff old vs new and fire fine-grained SolidJS signals for every
 * property that changed. This gives us:
 * - Correct fine-grained reactivity (nested text changes fire signals)
 * - Pure reducer logic (116 existing tests, predictable, testable)
 * - SolidJS-native signal integration (no intermediate signal bridge)
 *
 * Trade-off: reconcile() is O(state-tree-size) per dispatch. For typical
 * conversation sizes this is fast (~1ms). If profiling shows issues at
 * 500+ messages, switch the text_delta hot path to path-based setters.
 */

import { createStore as createSolidStore, reconcile } from "solid-js/store";
import { reduce } from "./reduce.js";
import type { TuiAction, TuiState } from "./types.js";

/** Listener callback — notified when state changes. */
export type StateListener = () => void;

/** Minimal store API — same interface as the previous reducer-based store. */
export interface TuiStore {
  /** Returns the reactive proxy. Reads inside Solid scopes are tracked. */
  readonly getState: () => TuiState;
  readonly dispatch: (action: TuiAction) => void;
  /**
   * Apply an array of actions in one pass and notify listeners once.
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

  // `let` justified: snapshot for reducer input (reconcile needs the raw state)
  let snapshot: TuiState = initialState;
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

  function applyState(next: TuiState): void {
    if (next === snapshot) return; // no-op guard
    snapshot = next;
    // reconcile() deep-diffs old vs new and fires signals for every change
    setState(reconcile(next));
  }

  function dispatch(action: TuiAction): void {
    applyState(reduce(snapshot, action));
    scheduleNotify();
  }

  function dispatchBatch(actions: readonly TuiAction[]): void {
    if (actions.length === 0) return;
    let current = snapshot;
    for (const action of actions) {
      current = reduce(current, action);
    }
    applyState(current);
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
