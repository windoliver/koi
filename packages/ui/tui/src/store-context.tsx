/**
 * StoreContext — React context for TuiStore + useTuiStore(selector) hook.
 *
 * Wraps useSyncExternalStore for tear-free concurrent-safe reads.
 * Selector support ensures components only re-render when their slice changes.
 */

import { createContext, useContext, useSyncExternalStore } from "react";
import type { TuiStore } from "./state/store.js";
import type { TuiState } from "./state/types.js";

/** React context carrying the TuiStore instance. */
export const StoreContext = createContext<TuiStore | null>(null);

/**
 * Select a slice of TUI state with automatic re-render on change.
 *
 * @param selector — pure function extracting the slice you need
 * @returns the selected value, re-rendered only when it changes (by reference)
 *
 * @example
 * ```tsx
 * const messages = useTuiStore(s => s.messages);
 * const view = useTuiStore(s => s.activeView);
 * ```
 */
export function useTuiStore<T>(selector: (state: TuiState) => T): T {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("useTuiStore must be used within a <StoreContext.Provider>");
  }
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
  );
}
