/**
 * TUI root component — top-level React component composing all views.
 *
 * Renders status bar, switches between agent list, console, and session views,
 * overlays command palette, and delegates keyboard shortcuts to the app handler.
 */

import type { KeyEvent, SyntaxStyle } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { TuiStore } from "../state/store.js";
import { COLORS } from "../theme.js";
import { AgentListView } from "./agent-list-view.js";
import { CommandPaletteView } from "./command-palette-view.js";
import { ConsoleView } from "./console-view.js";
import { DataSourcesView } from "./data-sources-view.js";
import { SessionPickerView } from "./session-picker-view.js";
import { StatusBarView } from "./status-bar-view.js";
import { useStoreState } from "./store-bridge.js";

/** Props for the root TUI component. */
export interface TuiRootProps {
  readonly store: TuiStore;
  readonly onConsoleInput: (text: string) => void;
  readonly onPaletteSelect: (commandId: string) => void;
  readonly onAgentSelect: (agentId: string) => void;
  readonly onPaletteCancel: () => void;
  /** Global keyboard shortcut handler — returns true if consumed. */
  readonly onKeyInput: (sequence: string) => boolean;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  /** Session picker callbacks. */
  readonly onSessionSelect?: ((sessionId: string) => void) | undefined;
  readonly onSessionCancel?: (() => void) | undefined;
  /** Data source callbacks. */
  readonly onDataSourceApprove?: ((name: string) => void) | undefined;
  readonly onDataSourceViewSchema?: ((name: string) => void) | undefined;
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
export function TuiRoot(props: TuiRootProps): React.ReactNode {
  const state = useStoreState(props.store);

  // Delegate all keyboard shortcuts to the app-level handler
  useKeyboard((key: KeyEvent) => {
    const seq = mapKeyEventToSequence(key);
    if (seq !== null) {
      props.onKeyInput(seq);
    }
  });

  const view = state.view;
  const agents = state.agents;
  const session = state.activeSession;
  const pendingText = session?.pendingText ?? "";
  const isPalette = view === "palette";
  const backgroundView = session !== null ? "console" : "agents";

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg}>
      <StatusBarView state={state} />

      <box flexGrow={1}>
        {/* Main content area — show agents, console, or sessions */}
        {(view === "agents" || (isPalette && backgroundView === "agents")) && (
          <AgentListView
            agents={agents}
            onSelect={props.onAgentSelect}
            focused={view === "agents"}
          />
        )}

        {(view === "console" || (isPalette && backgroundView === "console")) && (
          <ConsoleView
            session={session}
            pendingText={pendingText}
            onSubmit={props.onConsoleInput}
            focused={view === "console"}
            syntaxStyle={props.syntaxStyle}
          />
        )}

        {view === "datasources" && (
          <DataSourcesView
            sources={state.dataSources}
            loading={state.dataSourcesLoading}
            onApprove={props.onDataSourceApprove}
            onViewSchema={props.onDataSourceViewSchema}
            focused={true}
          />
        )}

        {view === "sessions" && (
          <SessionPickerView
            sessions={state.sessionPickerEntries}
            onSelect={props.onSessionSelect ?? (() => {})}
            onCancel={props.onSessionCancel ?? (() => {})}
            focused={true}
            loading={state.sessionPickerLoading}
          />
        )}

        {/* Command palette overlay */}
        <CommandPaletteView
          visible={isPalette}
          onSelect={props.onPaletteSelect}
          onCancel={props.onPaletteCancel}
          focused={isPalette}
        />
      </box>
    </box>
  );
}
