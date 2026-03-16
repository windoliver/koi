/**
 * TUI root component — top-level React component composing all views.
 *
 * Renders status bar, switches between views (including welcome mode),
 * overlays command palette, and delegates keyboard shortcuts.
 */

import type { KeyEvent, SyntaxStyle } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useMemo } from "react";
import { AgentSplitPane, type AgentPaneData } from "../components/agent-split-pane.js";
import type { TuiStore } from "../state/store.js";
import type { PresetInfo } from "../state/types.js";
import { COLORS } from "../theme.js";
import { AgentListView } from "./agent-list-view.js";
import { CommandPaletteView } from "./command-palette-view.js";
import { ConsentView } from "./consent-view.js";
import { ConsoleView } from "./console-view.js";
import { DataSourcesView } from "./data-sources-view.js";
import { ForgeView } from "./forge-view.js";
import { SessionPickerView } from "./session-picker-view.js";
import type { SourceDetailData } from "./source-detail-view.js";
import { SourceDetailView } from "./source-detail-view.js";
import { StatusBarView } from "./status-bar-view.js";
import { useStoreState } from "./store-bridge.js";

/** Props for the root TUI component. */
export interface TuiRootProps {
  readonly store: TuiStore;
  readonly onConsoleInput: (text: string) => void;
  readonly onPaletteSelect: (commandId: string) => void;
  readonly onAgentSelect: (agentId: string) => void;
  readonly onPaletteCancel: () => void;
  readonly onKeyInput: (sequence: string) => boolean;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly onSessionSelect?: ((sessionId: string) => void) | undefined;
  readonly onSessionCancel?: (() => void) | undefined;
  readonly onDataSourceApprove?: ((name: string) => void) | undefined;
  readonly onDataSourceViewSchema?: ((name: string) => void) | undefined;
  readonly onConsentApprove?: ((name: string) => void) | undefined;
  readonly onConsentDeny?: ((name: string) => void) | undefined;
  readonly onConsentDetails?: ((name: string) => void) | undefined;
  readonly onConsentDismiss?: (() => void) | undefined;
  readonly onPresetSelect?: ((presetId: string) => void) | undefined;
  readonly onPresetDetails?: ((presetId: string) => void) | undefined;
  readonly onPresetBack?: (() => void) | undefined;
}

/**
 * Map a KeyEvent from OpenTUI to the raw byte sequence expected
 * by the keyboard handler.
 */
function mapKeyEventToSequence(key: KeyEvent): string | null {
  if (key.ctrl) {
    switch (key.name) {
      case "p": return "\x10";
      case "r": return "\x12";
      case "o": return "\x0F";
      case "g": return "\x07";
    }
  }
  if (key.name === "Escape") return "\x1b";
  if (key.name === "Enter" || key.name === "Return") return "\r";
  if (key.name === "ArrowUp") return "\x1b[A";
  if (key.name === "ArrowDown") return "\x1b[B";
  // Single-char keys for view-specific shortcuts
  const SINGLE_KEYS = ["q", "a", "s", "j", "k", "y", "n", "d", "+", "?", " "];
  if (!key.ctrl && !key.meta && !key.shift && SINGLE_KEYS.includes(key.name)) {
    return key.name;
  }
  return null;
}

/** Root component for the TUI application. */
export function TuiRoot(props: TuiRootProps): React.ReactNode {
  const state = useStoreState(props.store);

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
  const backgroundView = session !== null ? "console" : view === "forge" ? "forge" : "agents";

  // Build split pane data from agents + PTY buffers
  const splitPaneData: readonly AgentPaneData[] = useMemo(() => {
    if (view !== "splitpanes") return [];
    return agents.map((agent) => {
      const chunks = state.ptyBuffers[agent.agentId] ?? [];
      // Decode base64 chunks into a single Uint8Array for the terminal
      const ptyData = chunks.length > 0
        ? new TextEncoder().encode(chunks.map((c) => atob(c)).join(""))
        : undefined;
      return {
        agentId: agent.agentId,
        agentName: agent.name,
        state: agent.state as AgentPaneData["state"],
        ptyData,
      };
    });
  }, [view, agents, state.ptyBuffers]);

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg}>
      <StatusBarView state={state} />

      <box flexGrow={1}>
        {/* Welcome mode */}
        {view === "welcome" && (
          <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
            <text fg={COLORS.cyan}><b>{"  Welcome to Koi"}</b></text>
            <text fg={COLORS.white}>
              {"  Koi is a self-extending agent engine. Select a preset to get started."}
            </text>
            <box marginTop={1} flexDirection="column" paddingLeft={2}>
              {state.presets.length > 0 ? (
                state.presets.map((preset: PresetInfo, i: number) => (
                  <box key={preset.id} height={1} flexDirection="row">
                    <text fg={i === state.selectedPresetIndex ? COLORS.cyan : COLORS.dim}>
                      {i === state.selectedPresetIndex ? " > " : "   "}
                    </text>
                    <text fg={i === state.selectedPresetIndex ? COLORS.white : COLORS.dim}>
                      {preset.id.padEnd(14)}
                    </text>
                    <text fg={COLORS.dim}>{preset.description}</text>
                  </box>
                ))
              ) : (
                <text fg={COLORS.dim}>{"  Loading presets..."}</text>
              )}
            </box>
            <box marginTop={2} paddingLeft={2} flexDirection="column">
              <text fg={COLORS.dim}><b>{"  Concepts:"}</b></text>
              <text fg={COLORS.dim}>{"  Manifest   — YAML file defining an agent"}</text>
              <text fg={COLORS.dim}>{"  Channel    — I/O interface to users (CLI, Slack, Discord)"}</text>
              <text fg={COLORS.dim}>{"  Middleware  — Intercepts model/tool calls (retry, audit)"}</text>
              <text fg={COLORS.dim}>{"  Engine     — Swappable agent loop"}</text>
              <text fg={COLORS.dim}>{"  Forge      — Self-improvement: agent behavior → tools"}</text>
              <text fg={COLORS.dim}>{"  Nexus      — Shared backend for data and coordination"}</text>
            </box>
            <box marginTop={1} paddingLeft={2}>
              <text fg={COLORS.dim}>{"  j/k:navigate  Enter:select  ?:details  q:quit"}</text>
            </box>
          </box>
        )}

        {/* Preset detail view */}
        {view === "presetdetail" && state.activePresetDetail !== null && (
          <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
            <text fg={COLORS.cyan}><b>{`  ${state.activePresetDetail.id}`}</b></text>
            <box marginTop={1} paddingLeft={2} flexDirection="column">
              <text>{`Nexus: ${state.activePresetDetail.nexusMode}`}</text>
              {state.activePresetDetail.demoPack !== undefined && (
                <text>{`Demo pack: ${state.activePresetDetail.demoPack}`}</text>
              )}
              {state.activePresetDetail.agentRoles !== undefined && state.activePresetDetail.agentRoles.length > 0 && (
                <box flexDirection="column" marginTop={1}>
                  <text fg={COLORS.cyan}><b>{"Agent roles:"}</b></text>
                  {state.activePresetDetail.agentRoles.map((role) => (
                    <text key={role.role} fg={COLORS.dim}>{`  ${role.role} — ${role.description}`}</text>
                  ))}
                </box>
              )}
              {Object.entries(state.activePresetDetail.stacks).filter(([, v]) => v === true).length > 0 && (
                <box marginTop={1} flexDirection="column">
                  <text fg={COLORS.cyan}><b>{"Stacks:"}</b></text>
                  <text fg={COLORS.dim}>
                    {"  " + Object.entries(state.activePresetDetail.stacks)
                      .filter(([, v]) => v === true)
                      .map(([k]) => k)
                      .join(", ")}
                  </text>
                </box>
              )}
              {state.activePresetDetail.prompts !== undefined && state.activePresetDetail.prompts.length > 0 && (
                <box marginTop={1} flexDirection="column">
                  <text fg={COLORS.cyan}><b>{"Sample prompts:"}</b></text>
                  {state.activePresetDetail.prompts.map((p, i) => (
                    <text key={i} fg={COLORS.dim}><i>{`  "${p}"`}</i></text>
                  ))}
                </box>
              )}
            </box>
            <box marginTop={1} paddingLeft={2}>
              <text fg={COLORS.dim}>{"  Enter:select  Esc:back  q:quit"}</text>
            </box>
          </box>
        )}

        {/* Boardroom views */}
        {(view === "agents" || (isPalette && backgroundView === "agents")) && (
          <AgentListView agents={agents} onSelect={props.onAgentSelect} focused={view === "agents"} zoomLevel={state.zoomLevel} />
        )}

        {(view === "console" || (isPalette && backgroundView === "console")) && (
          <ConsoleView
            session={session}
            pendingText={pendingText}
            onSubmit={props.onConsoleInput}
            focused={view === "console"}
            syntaxStyle={props.syntaxStyle}
            zoomLevel={state.zoomLevel}
          />
        )}

        {view === "datasources" && (
          <DataSourcesView
            sources={state.dataSources}
            loading={state.dataSourcesLoading}
            selectedIndex={state.selectedDataSourceIndex}
            onApprove={props.onDataSourceApprove}
            onViewSchema={props.onDataSourceViewSchema}
            focused={true}
            zoomLevel={state.zoomLevel}
          />
        )}

        {view === "sourcedetail" && (
          <SourceDetailView
            data={state.sourceDetail as SourceDetailData | null}
            loading={state.sourceDetailLoading}
            onApprove={props.onDataSourceApprove}
            onViewSchema={props.onDataSourceViewSchema}
            onBack={() => { props.store.dispatch({ kind: "set_view", view: "datasources" }); }}
            focused={true}
            syntaxStyle={props.syntaxStyle}
            zoomLevel={state.zoomLevel}
          />
        )}

        {view === "consent" && state.pendingConsent !== undefined && (
          <ConsentView
            sources={state.pendingConsent}
            onApprove={(name) => props.onConsentApprove?.(name)}
            onDeny={(name) => props.onConsentDeny?.(name)}
            onDetails={(name) => props.onConsentDetails?.(name)}
            onDismiss={() => props.onConsentDismiss?.()}
            focused={true}
            zoomLevel={state.zoomLevel}
          />
        )}

        {(view === "forge" || (isPalette && backgroundView === "forge")) && (
          <ForgeView state={state} focused={view === "forge"} zoomLevel={state.zoomLevel} />
        )}

        {view === "sessions" && (
          <SessionPickerView
            sessions={state.sessionPickerEntries}
            onSelect={props.onSessionSelect ?? (() => {})}
            onCancel={props.onSessionCancel ?? (() => {})}
            focused={true}
            loading={state.sessionPickerLoading}
            zoomLevel={state.zoomLevel}
          />
        )}

        {/* Split panes — per-agent terminal output */}
        {view === "splitpanes" && (
          <AgentSplitPane
            panes={splitPaneData}
            focusedIndex={state.focusedPaneIndex}
            onFocusChange={(index) => {
              props.store.dispatch({ kind: "set_focused_pane", index });
            }}
            onZoomToggle={() => {
              props.store.dispatch({ kind: "cycle_zoom" });
            }}
            maxScrollback={500}
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
