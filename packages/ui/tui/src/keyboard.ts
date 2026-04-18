/**
 * Global keyboard handler — two-layer architecture (Decision 1A).
 *
 * Layer 1 (this file): global shortcuts that fire regardless of which view
 * or component is focused: Ctrl+P (palette), Ctrl+C (interrupt), Esc.
 *
 * Layer 2: component-local handlers — each modal registers its own
 * useKeyboard and guards with `if (!focused) return`.
 *
 * `handleGlobalKey` is a pure function: no React, no hooks, no side effects.
 * Wrap the result of `createKeyboardHandler` in `useCallback(handler, [...])`
 * in the component (Decision 14A).
 *
 * Decision 9A: pure function enables full unit test coverage without mounting.
 */

import type { KeyEvent } from "@opentui/core";
import { isCtrlC, isCtrlN, isCtrlP, isEscape } from "./key-event.js";
import type { TuiStore } from "./state/store.js";
import type { TuiState } from "./state/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callbacks invoked by the global keyboard handler. */
export interface GlobalKeyCallbacks {
  /** Toggle the command palette (open if closed, close if open). */
  readonly onTogglePalette: () => void;
  /** Interrupt the currently running agent (Ctrl+C). */
  readonly onInterrupt: () => void;
  /** Dismiss the current modal — called when Esc fires with a modal open. */
  readonly onDismissModal: () => void;
  /** Navigate back — called when Esc fires with no modal open. */
  readonly onBack: () => void;
  /** Start a new session (Ctrl+N). */
  readonly onNewSession: () => void;
}

// ---------------------------------------------------------------------------
// Pure handler
// ---------------------------------------------------------------------------

/**
 * Handle a global key event given current TUI state and callbacks.
 *
 * Priority order: Ctrl+P > Ctrl+N (guarded) > Ctrl+C > Esc.
 *
 * @returns `true` if the key was consumed, `false` if unhandled (pass-through).
 */
export function handleGlobalKey(
  event: KeyEvent,
  state: TuiState,
  callbacks: GlobalKeyCallbacks,
): boolean {
  // Ctrl+P — toggle command palette
  if (isCtrlP(event)) {
    callbacks.onTogglePalette();
    return true;
  }

  // Ctrl+N — new session (only on conversation view with no modal and no
  // inline overlay open; slash/@ overlays and TrajectoryView use Ctrl+N
  // as down-arrow locally)
  if (
    isCtrlN(event) &&
    state.modal === null &&
    state.activeView === "conversation" &&
    state.slashQuery === null &&
    state.atQuery === null
  ) {
    callbacks.onNewSession();
    return true;
  }

  // Ctrl+C — interrupt agent
  if (isCtrlC(event)) {
    callbacks.onInterrupt();
    return true;
  }

  // Esc priority:
  //   1. agent streaming → interrupt (CC parity: Esc cancels generation)
  //   2. modal open → dismiss
  //   3. default → navigate back
  if (isEscape(event)) {
    if (state.agentStatus === "processing") {
      callbacks.onInterrupt();
    } else if (state.modal !== null) {
      callbacks.onDismissModal();
    } else {
      callbacks.onBack();
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Hook adapter
// ---------------------------------------------------------------------------

/**
 * Create a stable keyboard handler function for `useKeyboard` registration.
 *
 * Reads state at event-time via `store.getState()` — no stale-closure risk.
 * The caller should wrap the result in `useCallback(handler, [store, ...deps])`
 * before passing it to `useKeyboard`.
 */
export function createKeyboardHandler(
  store: TuiStore,
  callbacks: GlobalKeyCallbacks,
): (event: KeyEvent) => void {
  return (event: KeyEvent): void => {
    handleGlobalKey(event, store.getState(), callbacks);
  };
}
