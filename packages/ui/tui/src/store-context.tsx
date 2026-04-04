/**
 * StoreContext — Solid context for TuiStore + useTuiStore(selector) accessor.
 *
 * Bridges the external TuiStore (subscribe/dispatch/getState) into Solid's
 * reactive system. A *single* state signal is created once per component tree
 * (by the TuiRoot component) and shared through TuiStateContext. All useTuiStore
 * selectors derive from that one signal, guaranteeing snapshot consistency: every
 * selector in a single render sees the same post-dispatch state.
 *
 * This avoids the torn-read hazard of N independent subscriptions, where
 * Solid could run a memo that reads selector A after its signal updated but
 * before selector B's signal had caught up to the same dispatch.
 */

import {
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import type { TuiStore } from "./state/store.js";
import type { TuiState } from "./state/types.js";

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/** Solid context carrying the TuiStore instance. */
export const StoreContext: ReturnType<
  typeof createContext<TuiStore | null>
> = createContext<TuiStore | null>(null);

/**
 * Solid context carrying the single shared reactive state signal for a tree.
 * Created once by TuiRoot; consumed by every useTuiStore call in the subtree.
 */
export const TuiStateContext: ReturnType<
  typeof createContext<Accessor<TuiState> | null>
> = createContext<Accessor<TuiState> | null>(null);

// ---------------------------------------------------------------------------
// Public hooks
// ---------------------------------------------------------------------------

/**
 * Create a single reactive state signal bound to the given store.
 * Call this once per component tree (e.g. inside TuiRoot) and provide
 * the result via TuiStateContext.Provider.
 */
export function createStoreSignal(store: TuiStore): Accessor<TuiState> {
  const [state, setState] = createSignal(store.getState());
  const unsub = store.subscribe(() => setState(store.getState()));
  onCleanup(unsub);
  return state;
}

/**
 * Select a slice of TUI state. Returns a **Solid Accessor** (a getter function)
 * that only fires when the selected value changes (Object.is equality default).
 *
 * BREAKING CHANGE from React version: previously returned `T` directly.
 * Now returns `Accessor<T>` — call the result to read the value:
 * ```tsx
 * const messages = useTuiStore(s => s.messages); // Accessor<TuiMessage[]>
 * // In JSX: {messages()}  — NOT {messages}
 * ```
 *
 * @koi/tui is private (workspace-only); all internal consumers have been updated.
 *
 * All selectors in the same tree share one underlying signal, so a single
 * dispatch is always observed as a consistent snapshot regardless of how many
 * selectors a component registers.
 *
 * Call site is identical to the former React useSyncExternalStore version:
 * ```tsx
 * const messages = useTuiStore(s => s.messages);
 * const view = useTuiStore(s => s.activeView);
 * ```
 */
export function useTuiStore<T>(selector: (state: TuiState) => T): Accessor<T> {
  const stateSignal = useContext(TuiStateContext);
  if (!stateSignal) {
    throw new Error(
      "useTuiStore must be used within a component tree that provides TuiStateContext " +
        "(TuiRoot sets this up automatically).",
    );
  }
  return createMemo(() => selector(stateSignal()));
}

// Re-export JSX namespace types consumed by callers
export type { JSX };
