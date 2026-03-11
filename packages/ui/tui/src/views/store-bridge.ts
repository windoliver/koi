/**
 * Store bridge — connects TuiStore to React state.
 *
 * Uses useSyncExternalStore for tear-free reads from the TuiStore.
 * This ensures React always sees a consistent snapshot of the store.
 */

import { useMemo, useSyncExternalStore } from "react";
import type { TuiStore } from "../state/store.js";
import type { TuiState } from "../state/types.js";

/** Hook that tracks the full TuiState. */
export function useStoreState(store: TuiStore): TuiState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** Hook that selects a derived slice of TuiState. */
export function useDerivedState<T>(store: TuiStore, selector: (state: TuiState) => T): T {
  const state = useStoreState(store);
  return useMemo(() => selector(state), [state, selector]);
}
