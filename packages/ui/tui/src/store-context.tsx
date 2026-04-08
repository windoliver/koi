/**
 * StoreContext — Solid context for TuiStore + useTuiStore(selector) accessor.
 *
 * With the SolidJS store + reconcile() backend, getState() returns a reactive
 * proxy. Selectors access proxy properties inside the returned getter, so
 * SolidJS tracks dependencies at the call site (JSX, createEffect, createMemo).
 *
 * We intentionally do NOT wrap in createMemo here — reconcile() preserves
 * proxy object identity for unchanged subtrees, which means createMemo's
 * Object.is check would cache stale references for array/object selectors
 * (sessions, metrics, messages). Direct getters let every consumer site
 * track exactly the store paths it reads.
 */

import { createContext, useContext, type Accessor, type JSX } from "solid-js";
import type { TuiStore } from "./state/store.js";
import type { TuiState } from "./state/types.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Solid context carrying the TuiStore instance. */
export const StoreContext: ReturnType<typeof createContext<TuiStore | null>> =
  createContext<TuiStore | null>(null);

// ---------------------------------------------------------------------------
// Public hooks
// ---------------------------------------------------------------------------

/**
 * Select a slice of TUI state. Returns a **Solid Accessor** (a getter function)
 * that evaluates the selector against the reactive store proxy on each read.
 *
 * Since `store.getState()` returns a SolidJS reactive proxy, property reads
 * inside the selector are tracked at the CALL SITE (JSX expression, createEffect,
 * createMemo). This works correctly for both scalar and object/array selectors:
 * - `s => s.activeView` — tracked when the getter is called inside JSX
 * - `s => s.messages` — returns the proxy array; For/Show track nested changes
 * - `s => s.runningToolCount > 0` — evaluated fresh on each read
 *
 * Call site:
 * ```tsx
 * const messages = useTuiStore(s => s.messages); // Accessor<TuiMessage[]>
 * // In JSX: {messages()}  — NOT {messages}
 * ```
 */
export function useTuiStore<T>(selector: (state: TuiState) => T): Accessor<T> {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error(
      "useTuiStore must be used within a component tree that provides StoreContext " +
        "(TuiRoot sets this up automatically).",
    );
  }
  // Direct getter — no createMemo. SolidJS tracks reactive reads at the call
  // site. createMemo would cache by Object.is and miss proxy-identity-preserved
  // updates from reconcile() for array/object selectors.
  return () => selector(store.getState());
}

// Re-export JSX namespace types consumed by callers
export type { JSX };
