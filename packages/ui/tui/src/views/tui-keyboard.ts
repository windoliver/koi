/**
 * Keyboard handler — global keyboard shortcuts for the TUI.
 *
 * Registers shortcuts: Ctrl+P (palette), Ctrl+R (refresh),
 * Ctrl+O (browser), Ctrl+G (forge), q (quit), Esc (back/close),
 * + (cycle zoom), j/k (navigate in welcome/datasources).
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
  readonly presetSelect: () => void;
  readonly presetDetails: () => void;
  readonly presetBack: () => void;
  readonly toggleSplitPanes: () => void;
  readonly nameConfirm: () => void;
  readonly nameBack: () => void;
  readonly addonsConfirm: () => void;
  readonly addonsSkip: () => void;
  readonly addonsToggle: () => void;
  readonly addonsBack: () => void;
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

    // Ctrl+P — toggle command palette (not in welcome mode)
    if (sequence === "\x10" && view !== "welcome" && view !== "presetdetail") {
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

    // + — cycle zoom level
    if (sequence === "+") {
      store.dispatch({ kind: "cycle_zoom" });
      return true;
    }

    // Split pane controls: Tab (focus next), Enter (zoom toggle), Esc (back)
    if (view === "splitpanes") {
      if (sequence === "\t") {
        // Tab: cycle focused pane
        const paneCount =
          Object.keys(store.getState().splitSessions).length || store.getState().agents.length;
        const next = (store.getState().focusedPaneIndex + 1) % Math.max(1, paneCount);
        store.dispatch({ kind: "set_focused_pane", index: next });
        return true;
      }
      if (sequence === "\r") {
        // Enter: zoom focused pane
        store.dispatch({ kind: "cycle_zoom" });
        return true;
      }
      if (sequence === "\x1b") {
        if (store.getState().zoomLevel !== "normal") {
          store.dispatch({ kind: "set_zoom_level", level: "normal" });
        } else {
          store.dispatch({ kind: "set_view", view: "agents" });
        }
        return true;
      }
    }

    // Welcome mode — j/k navigation, Enter to select, ? for details, q to quit
    if (view === "welcome") {
      if (sequence === "j" || sequence === "\x1b[B") {
        store.dispatch({
          kind: "select_preset",
          index: store.getState().selectedPresetIndex + 1,
        });
        return true;
      }
      if (sequence === "k" || sequence === "\x1b[A") {
        store.dispatch({
          kind: "select_preset",
          index: store.getState().selectedPresetIndex - 1,
        });
        return true;
      }
      if (sequence === "\r") {
        callbacks.presetSelect();
        return true;
      }
      if (sequence === "?") {
        callbacks.presetDetails();
        return true;
      }
      if (sequence === "q") {
        callbacks.stop();
        return true;
      }
      return false;
    }

    // Preset detail view — Enter to select, Esc to go back, q to quit
    if (view === "presetdetail") {
      if (sequence === "\r") {
        callbacks.presetSelect();
        return true;
      }
      if (sequence === "\x1b") {
        callbacks.presetBack();
        return true;
      }
      if (sequence === "q") {
        callbacks.stop();
        return true;
      }
      return false;
    }

    // Name input — Enter to confirm, Esc to go back
    // (actual text input is handled by the <textarea> component, not here)
    if (view === "nameinput") {
      if (sequence === "\r") {
        callbacks.nameConfirm();
        return true;
      }
      if (sequence === "\x1b") {
        callbacks.nameBack();
        return true;
      }
      return false;
    }

    // Add-on picker — j/k navigate, Space toggle, Enter confirm, s skip, Esc back
    if (view === "addons") {
      if (sequence === "\r") {
        callbacks.addonsConfirm();
        return true;
      }
      if (sequence === " ") {
        callbacks.addonsToggle();
        return true;
      }
      if (sequence === "s") {
        callbacks.addonsSkip();
        return true;
      }
      if (sequence === "\x1b") {
        callbacks.addonsBack();
        return true;
      }
      return false;
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
      if (view === "datasources" || view === "sourcedetail") {
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
