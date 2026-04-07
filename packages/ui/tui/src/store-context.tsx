/**
 * StoreContext — Solid context for TuiStore + useTuiStore(selector) accessor.
 *
 * With the SolidJS store backend, getState() returns a reactive proxy.
 * All useTuiStore selectors run inside createMemo, so property accesses
 * are automatically tracked by Solid's fine-grained reactivity system.
 *
 * No intermediate signal bridge is needed — the store proxy IS reactive.
 */

import { createContext, createMemo, useContext, type Accessor, type JSX } from "solid-js";
import type { TuiStore } from "./state/store.js";
import type { TuiMessage, TuiState } from "./state/types.js";

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
 * that only re-computes when the accessed reactive properties change.
 *
 * Since `store.getState()` returns a SolidJS reactive proxy, property reads
 * inside the selector are automatically tracked. For example:
 * - `s => s.activeView` — only fires when activeView changes
 * - `s => s.messages` — fires when messages array changes (add/remove)
 * - `s => s.runningToolCount > 0` — fires only when the count crosses zero
 *
 * @koi/tui is private (workspace-only); all internal consumers have been updated.
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
  return createMemo(() => selector(store.getState()));
}

/**
 * Access the store's messages array as a direct reactive proxy.
 *
 * Unlike `useTuiStore(s => s.messages)`, this does NOT wrap in createMemo.
 * createMemo caches by reference equality — since the SolidJS store always
 * returns the same proxy object, the memo never re-fires for nested changes
 * like `block.text += delta`. Direct proxy access lets SolidJS's `For`
 * component and JSX expressions track nested store paths natively.
 *
 * Use this for store arrays/objects where nested reactivity is needed.
 * Use `useTuiStore` for scalar values (string, number, boolean) where
 * memo caching is correct and efficient.
 */
export function useStoreMessages(): () => readonly TuiMessage[] {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error(
      "useStoreMessages must be used within a component tree that provides StoreContext.",
    );
  }
  return () => store.getState().messages;
}

// Re-export JSX namespace types consumed by callers
export type { JSX };
