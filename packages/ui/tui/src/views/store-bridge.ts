/**
 * Store bridge — connects TuiStore to SolidJS reactive signals.
 *
 * Creates fine-grained SolidJS accessors from the TuiStore's
 * subscribe/getState pattern. Cleanup handled by onCleanup.
 */

import { type Accessor, createMemo, createSignal, onCleanup } from "solid-js";
import type { TuiStore } from "../state/store.js";
import type { TuiState } from "../state/types.js";

/** Create a SolidJS signal that tracks the full TuiState. */
export function createStoreSignal(store: TuiStore): Accessor<TuiState> {
  const [state, setState] = createSignal(store.getState());
  const unsub = store.subscribe((s) => setState(() => s));
  onCleanup(unsub);
  return state;
}

/** Create a derived signal that only updates when the selected slice changes. */
export function createDerivedSignal<T>(
  store: TuiStore,
  selector: (state: TuiState) => T,
): Accessor<T> {
  const state = createStoreSignal(store);
  return createMemo(() => selector(state()));
}
