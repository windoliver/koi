/**
 * Keyboard handler — global keyboard shortcuts for the TUI.
 *
 * Extracted from tui-app to keep the orchestrator lean.
 * Registers shortcuts: Ctrl+P (palette), Ctrl+R (refresh),
 * Ctrl+O (browser), Ctrl+G (forge), q (quit), Esc (back/close).
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
  readonly closeDataSources: () => void;
  readonly dataSourceUp: () => void;
  readonly dataSourceDown: () => void;
  readonly dataSourceApprove: () => void;
  readonly dataSourceSchema: () => void;
  readonly consentApprove: () => void;
  readonly consentDeny: () => void;
  readonly consentDetails: () => void;
  readonly closeConsent: () => void;
  readonly toggleForge: () => void;
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

    // Ctrl+G — toggle forge view
    if (sequence === "\x07") {
      callbacks.toggleForge();
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
      if (view === "datasources") {
        callbacks.closeDataSources();
        return true;
      }
      if (view === "sourcedetail") {
        callbacks.closeDataSources();
        return true;
      }
      if (view === "consent") {
        callbacks.closeConsent();
        return true;
      }
      if (view === "forge") {
        callbacks.toggleForge();
        return true;
      }
    }

    // Consent view — y/n/d keys
    if (view === "consent") {
      if (sequence === "y") {
        callbacks.consentApprove();
        return true;
      }
      if (sequence === "n") {
        callbacks.consentDeny();
        return true;
      }
      if (sequence === "d") {
        callbacks.consentDetails();
        return true;
      }
    }

    // Data sources view — arrow keys and action keys
    if (view === "datasources") {
      if (sequence === "\x1b[A" || sequence === "k") {
        callbacks.dataSourceUp();
        return true;
      }
      if (sequence === "\x1b[B" || sequence === "j") {
        callbacks.dataSourceDown();
        return true;
      }
      if (sequence === "a") {
        callbacks.dataSourceApprove();
        return true;
      }
      if (sequence === "s") {
        callbacks.dataSourceSchema();
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
