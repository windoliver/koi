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
  readonly dataSourcesContinue: () => void;
  readonly consentApprove: () => void;
  readonly consentDeny: () => void;
  readonly consentDetails: () => void;
  readonly closeConsent: () => void;
  readonly toggleForge: () => void;
  readonly toggleCost: () => void;
  readonly toggleNexus: () => void;
  readonly navigateBack: () => void;
  readonly domainScrollUp: () => void;
  readonly domainScrollDown: () => void;
  readonly temporalSelectNext: () => void;
  readonly temporalSelectPrev: () => void;
  readonly temporalDetail: () => void;
  readonly temporalSignal: () => void;
  readonly temporalTerminate: () => void;
  readonly schedulerRetryDlq: () => void;
  readonly harnessPauseResume: () => void;
  readonly governanceSelectNext: () => void;
  readonly governanceSelectPrev: () => void;
  readonly governanceApprove: () => void;
  readonly governanceDeny: () => void;
  readonly forgeSelectNext: () => void;
  readonly forgeSelectPrev: () => void;
  readonly forgePromote: () => void;
  readonly forgeDemote: () => void;
  readonly forgeQuarantine: () => void;
  readonly nexusBrowserSelectNext: () => void;
  readonly nexusBrowserSelectPrev: () => void;
  readonly nexusBrowserOpen: () => void;
  readonly nexusBrowserBack: () => void;
  readonly scratchpadOpen: () => void;
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
  readonly modelSelect: () => void;
  readonly modelBack: () => void;
  readonly engineConfirm: () => void;
  readonly engineSkip: () => void;
  readonly engineBack: () => void;
  readonly channelsConfirm: () => void;
  readonly channelsToggle: () => void;
  readonly channelsBack: () => void;
  readonly nexusConfigConfirm: () => void;
  readonly nexusConfigBack: () => void;
  readonly serviceStop: () => void;
  readonly serviceDoctor: () => void;
  readonly serviceLogs: () => void;
  readonly serviceBack: () => void;
  readonly logsCycleLevel: () => void;
  readonly logsBack: () => void;
  readonly openSessionPicker: () => void;
  readonly newSession: () => void;
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

    // Ctrl+C — always quit (raw mode swallows SIGINT)
    if (sequence === "\x03") {
      callbacks.stop();
      return true;
    }

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

    // Ctrl+F — toggle nexus files view
    if (sequence === "\x06") {
      callbacks.toggleNexus();
      return true;
    }

    // Ctrl+N — new session with current/first agent
    if (sequence === "\x0E") {
      callbacks.newSession();
      return true;
    }

    // + — cycle zoom level
    if (sequence === "+") {
      store.dispatch({ kind: "cycle_zoom" });
      return true;
    }

    // 1-5 — switch primary tabs (Agents, Console, Forge, Sources, Sessions)
    const TAB_KEYS: Readonly<Record<string, string>> = {
      "1": "agents",
      "2": "console",
      "3": "forge",
      "4": "datasources",
      "5": "sessions",
    };
    if (sequence in TAB_KEYS) {
      const target = TAB_KEYS[sequence] as string;
      // Console requires an active agent session
      if (target === "console" && store.getState().activeSession === null) return true;
      // Sessions tab needs data fetch, not just view switch
      if (target === "sessions") {
        callbacks.openSessionPicker();
        return true;
      }
      store.dispatch({ kind: "set_view", view: target as import("../state/types.js").TuiView });
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
      if (sequence === "j" || sequence === "\x1b[B") {
        store.dispatch({
          kind: "set_addon_focused_index",
          index: store.getState().addonFocusedIndex + 1,
        });
        return true;
      }
      if (sequence === "k" || sequence === "\x1b[A") {
        store.dispatch({
          kind: "set_addon_focused_index",
          index: store.getState().addonFocusedIndex - 1,
        });
        return true;
      }
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

    // Nexus config step — j/k navigate, Enter select & confirm, Esc back
    if (view === "nexusconfig") {
      if (sequence === "j" || sequence === "\x1b[B") {
        store.dispatch({
          kind: "set_nexus_config_focused_index",
          index: store.getState().nexusConfigFocusedIndex + 1,
        });
        return true;
      }
      if (sequence === "k" || sequence === "\x1b[A") {
        store.dispatch({
          kind: "set_nexus_config_focused_index",
          index: store.getState().nexusConfigFocusedIndex - 1,
        });
        return true;
      }
      if (sequence === "\r") {
        callbacks.nexusConfigConfirm();
        return true;
      }
      if (sequence === "\x1b") {
        callbacks.nexusConfigBack();
        return true;
      }
      return false;
    }

    // Model step — j/k navigate, Enter confirm, Esc back
    if (view === "model") {
      if (sequence === "j" || sequence === "\x1b[B") {
        store.dispatch({
          kind: "set_model_focused_index",
          index: store.getState().modelFocusedIndex + 1,
        });
        return true;
      }
      if (sequence === "k" || sequence === "\x1b[A") {
        store.dispatch({
          kind: "set_model_focused_index",
          index: store.getState().modelFocusedIndex - 1,
        });
        return true;
      }
      if (sequence === "\r") {
        callbacks.modelSelect();
        return true;
      }
      if (sequence === "\x1b") {
        callbacks.modelBack();
        return true;
      }
      return false;
    }

    // Engine step — Enter confirm, s skip, Esc back
    if (view === "engine") {
      if (sequence === "\r") {
        callbacks.engineConfirm();
        return true;
      }
      if (sequence === "s") {
        callbacks.engineSkip();
        return true;
      }
      if (sequence === "\x1b") {
        callbacks.engineBack();
        return true;
      }
      return false;
    }

    // Channels step — j/k, Space toggle, Enter confirm, Esc back
    if (view === "channels") {
      if (sequence === "j" || sequence === "\x1b[B") {
        store.dispatch({
          kind: "set_channel_focused_index",
          index: store.getState().channelFocusedIndex + 1,
        });
        return true;
      }
      if (sequence === "k" || sequence === "\x1b[A") {
        store.dispatch({
          kind: "set_channel_focused_index",
          index: store.getState().channelFocusedIndex - 1,
        });
        return true;
      }
      if (sequence === " ") {
        callbacks.channelsToggle();
        return true;
      }
      if (sequence === "\r") {
        callbacks.channelsConfirm();
        return true;
      }
      if (sequence === "\x1b") {
        callbacks.channelsBack();
        return true;
      }
      return false;
    }

    // Progress view — q to quit, otherwise read-only
    if (view === "progress") {
      if (sequence === "q") {
        callbacks.stop();
        return true;
      }
      return false;
    }

    // Service view — s=stop, d=doctor, l=logs, Esc=back
    if (view === "service") {
      if (sequence === "s") {
        callbacks.serviceStop();
        return true;
      }
      if (sequence === "d") {
        callbacks.serviceDoctor();
        return true;
      }
      if (sequence === "l") {
        callbacks.serviceLogs();
        return true;
      }
      if (sequence === "\x1b") {
        callbacks.serviceBack();
        return true;
      }
      return false;
    }

    // Doctor view — Esc=back
    if (view === "doctor") {
      if (sequence === "\x1b") {
        callbacks.serviceBack();
        return true;
      }
      return false;
    }

    // Logs view — l=cycle level, Esc=back
    if (view === "logs") {
      if (sequence === "l") {
        callbacks.logsCycleLevel();
        return true;
      }
      if (sequence === "\x1b") {
        callbacks.logsBack();
        return true;
      }
      return false;
    }

    // Temporal view — j/k navigate workflows, Enter detail, s signal, t terminate
    if (view === "temporal") {
      if (sequence === "j" || sequence === "\x1b[B") {
        callbacks.temporalSelectNext();
        return true;
      }
      if (sequence === "k" || sequence === "\x1b[A") {
        callbacks.temporalSelectPrev();
        return true;
      }
      if (sequence === "\r") {
        callbacks.temporalDetail();
        return true;
      }
      if (sequence === "s") {
        callbacks.temporalSignal();
        return true;
      }
      if (sequence === "t") {
        callbacks.temporalTerminate();
        return true;
      }
    }

    // Scheduler view — r retry DLQ
    if (view === "scheduler") {
      if (sequence === "r") {
        callbacks.schedulerRetryDlq();
        return true;
      }
    }

    // Harness view — p pause/resume toggle
    if (view === "harness") {
      if (sequence === "p") {
        callbacks.harnessPauseResume();
        return true;
      }
    }

    // Governance view — j/k navigate, a approve, d deny
    if (view === "governance") {
      if (sequence === "j" || sequence === "\x1b[B") {
        callbacks.governanceSelectNext();
        return true;
      }
      if (sequence === "k" || sequence === "\x1b[A") {
        callbacks.governanceSelectPrev();
        return true;
      }
      if (sequence === "a") {
        callbacks.governanceApprove();
        return true;
      }
      if (sequence === "d") {
        callbacks.governanceDeny();
        return true;
      }
    }

    // Forge view — j/k navigate bricks, p promote, d demote, q quarantine
    if (view === "forge") {
      if (sequence === "j" || sequence === "\x1b[B") {
        callbacks.forgeSelectNext();
        return true;
      }
      if (sequence === "k" || sequence === "\x1b[A") {
        callbacks.forgeSelectPrev();
        return true;
      }
      if (sequence === "p") {
        callbacks.forgePromote();
        return true;
      }
      if (sequence === "d") {
        callbacks.forgeDemote();
        return true;
      }
      if (sequence === "q") {
        callbacks.forgeQuarantine();
        return true;
      }
    }

    // Nexus file browser — j/k navigate, Enter open, Esc/Backspace back
    if (view === "files") {
      if (sequence === "j" || sequence === "\x1b[B") {
        callbacks.nexusBrowserSelectNext();
        return true;
      }
      if (sequence === "k" || sequence === "\x1b[A") {
        callbacks.nexusBrowserSelectPrev();
        return true;
      }
      if (sequence === "\r") {
        callbacks.nexusBrowserOpen();
        return true;
      }
    }

    // Scratchpad view — Enter to read selected entry
    if (view === "scratchpad") {
      if (sequence === "\r") {
        callbacks.scratchpadOpen();
        return true;
      }
    }

    // Other domain views with j/k scroll support
    const SCROLLABLE_VIEWS = new Set([
      "skills",
      "channels",
      "system",
      "nexus",
      "gateway",
      "scheduler",
      "taskboard",
      "harness",
      "middleware",
      "processtree",
      "agentprocfs",
      "cost",
      "delegation",
      "handoffs",
      "mailbox",
      "scratchpad",
    ]);
    if (SCROLLABLE_VIEWS.has(view)) {
      if (sequence === "j" || sequence === "\x1b[B") {
        callbacks.domainScrollDown();
        return true;
      }
      if (sequence === "k" || sequence === "\x1b[A") {
        callbacks.domainScrollUp();
        return true;
      }
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
      if (view === "files") {
        callbacks.nexusBrowserBack();
        return true;
      }
      if (SCROLLABLE_VIEWS.has(view) || view === "temporal" || view === "governance") {
        callbacks.navigateBack();
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
      if (sequence === "\r") {
        callbacks.dataSourcesContinue();
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
