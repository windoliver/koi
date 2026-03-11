/**
 * TUI root component — top-level SolidJS component composing all views.
 *
 * Renders status bar, switches between agent list and console views,
 * overlays command palette, and handles global keyboard shortcuts.
 */

import type { CliRenderer, KeyEvent, SyntaxStyle } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { Match, Switch, onMount } from "solid-js";
import type { TuiStore } from "../state/store.js";
import { COLORS } from "../theme.js";
import { AgentListView } from "./agent-list-view.js";
import { CommandPaletteView } from "./command-palette-view.js";
import { ConsoleView } from "./console-view.js";
import { StatusBarView } from "./status-bar-view.js";
import { createStoreSignal } from "./store-bridge.js";

/** Props for the root TUI component. */
export interface TuiRootProps {
  readonly store: TuiStore;
  readonly onConsoleInput: (text: string) => void;
  readonly onPaletteSelect: (commandId: string) => void;
  readonly onAgentSelect: (agentId: string) => void;
  readonly onPaletteCancel: () => void;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly onRendererReady?: (renderer: CliRenderer) => void;
}

/**
 * Map a KeyEvent from OpenTUI to the raw byte sequence expected
 * by the keyboard handler. Only maps known global shortcuts.
 */
function mapKeyEventToSequence(key: KeyEvent): string | null {
  if (key.ctrl) {
    switch (key.name) {
      case "p":
        return "\x10"; // Ctrl+P
      case "r":
        return "\x12"; // Ctrl+R
      case "o":
        return "\x0F"; // Ctrl+O
    }
  }
  if (key.name === "Escape") return "\x1b";
  if (key.name === "q" && !key.ctrl && !key.meta && !key.shift) return "q";
  return null;
}

/** Root component for the TUI application. */
export function TuiRoot(props: TuiRootProps): JSX.Element {
  const state = createStoreSignal(props.store);
  const renderer = useRenderer();

  onMount(() => {
    if (props.onRendererReady !== undefined) {
      props.onRendererReady(renderer);
    }
  });

  // Global keyboard shortcuts
  useKeyboard((key: KeyEvent) => {
    const seq = mapKeyEventToSequence(key);
    if (seq !== null) {
      // Dispatch to the existing keyboard handler via store
      const view = state().view;

      // Ctrl+P — toggle palette
      if (seq === "\x10") {
        if (view === "palette") {
          props.onPaletteCancel();
        } else {
          props.store.dispatch({ kind: "set_view", view: "palette" });
        }
        return;
      }

      // Escape — close palette or go back
      if (seq === "\x1b") {
        if (view === "palette") {
          props.onPaletteCancel();
          return;
        }
        if (view === "console") {
          props.onPaletteCancel();
          return;
        }
      }

      // q — quit from agents view
      if (seq === "q" && view === "agents") {
        // Let the app handle quit
        props.store.dispatch({ kind: "set_view", view: "agents" });
      }
    }
  });

  const view = () => state().view;
  const agents = () => state().agents;
  const session = () => state().activeSession;
  const pendingText = () => session()?.pendingText ?? "";
  const isPalette = () => view() === "palette";
  const backgroundView = () => (session() !== null ? "console" : "agents");

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg}>
      <StatusBarView state={state} />

      <box flexGrow={1}>
        {/* Main content area — show agents or console */}
        <Switch>
          <Match when={view() === "agents" || (isPalette() && backgroundView() === "agents")}>
            <AgentListView
              agents={agents}
              onSelect={props.onAgentSelect}
              focused={view() === "agents"}
            />
          </Match>

          <Match when={view() === "console" || (isPalette() && backgroundView() === "console")}>
            <ConsoleView
              session={session}
              pendingText={() => pendingText()}
              onSubmit={props.onConsoleInput}
              focused={view() === "console"}
              syntaxStyle={props.syntaxStyle}
            />
          </Match>
        </Switch>

        {/* Command palette overlay */}
        <CommandPaletteView
          visible={isPalette}
          onSelect={props.onPaletteSelect}
          onCancel={props.onPaletteCancel}
          focused={isPalette()}
        />
      </box>
    </box>
  );
}
