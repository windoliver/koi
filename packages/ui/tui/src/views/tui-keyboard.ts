/**
 * Keyboard handler — global keyboard shortcuts for the TUI.
 *
 * Extracted from tui-app to keep the orchestrator lean.
 * Registers shortcuts: Ctrl+P (palette), Ctrl+R (refresh),
 * Ctrl+O (browser), q (quit), Esc (back/close).
 */

import type { TuiStore } from "../state/store.js";

/** Callbacks for keyboard actions that require app-level coordination. */
export interface KeyboardCallbacks {
  readonly togglePalette: () => void;
  readonly refreshAgents: () => void;
  readonly openInBrowser: () => void;
  readonly stop: () => void;
  readonly cancelAndGoBack: () => void;
  readonly closeSessions: () => void;
}

/**
 * Create a keyboard input handler.
 *
 * Returns a function that processes raw byte sequences from OpenTUI's
 * useKeyboard hook (mapped via mapKeyEventToSequence in tui-root).
 * Returns true if the key was consumed, false to delegate to components.
 */
export function createKeyboardHandler(
  store: TuiStore,
  callbacks: KeyboardCallbacks,
): (sequence: string) => boolean {
  return (sequence: string): boolean => {
    const view = store.getState().view;

    // Ctrl+P — toggle command palette
    if (sequence === "\x10") {
      callbacks.togglePalette();
      return true;
    }

    // Ctrl+R — refresh agents
    if (sequence === "\x12") {
      callbacks.refreshAgents();
      return true;
    }

    // Ctrl+O — open in browser
    if (sequence === "\x0F") {
      callbacks.openInBrowser();
      return true;
    }

    // Escape — context-dependent back/close
    if (sequence === "\x1b") {
      if (view === "palette") {
        callbacks.togglePalette();
        return true;
      }
      if (view === "console") {
        callbacks.cancelAndGoBack();
        return true;
      }
      if (view === "sessions") {
        callbacks.closeSessions();
        return true;
      }
    }

    // q — quit (only in agent list view, not when typing)
    if (view === "agents" && sequence === "q") {
      callbacks.stop();
      return true;
    }

    return false;
  };
}
