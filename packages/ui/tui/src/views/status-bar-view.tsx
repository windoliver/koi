/**
 * Status bar v2 — two-line header with panel indicators and context hints.
 *
 * Line 1: Mode indicator + view tabs + agent count + cost/token summary
 * Line 2: Context-sensitive keyboard hints for the focused panel
 */

import { useMemo } from "react";
import { COLORS, connectionStatusConfig } from "../theme.js";
import type { TuiState, TuiView, ZoomLevel } from "../state/types.js";

/** View-specific keyboard hints. */
const VIEW_HINTS: Readonly<Record<TuiView, string>> = {
  agents: "↑↓:navigate  Enter:select  Ctrl+G:forge  Ctrl+P:commands  q:quit",
  consent: "[y] approve  [n] deny  [d] details  Esc:dismiss",
  console: "Type message  Enter:send  Esc:back  Ctrl+P:commands",
  datasources: "↑↓:navigate  [a] approve  [s] schema  Esc:back",
  forge: "Esc:back  Ctrl+G:close  Ctrl+P:commands",
  presetdetail: "Enter:select  Esc:back  q:quit",
  sourcedetail: "Esc:back  [a] approve",
  palette: "↑↓:navigate  Enter:select  Esc:close",
  sessions: "↑↓:navigate  Enter:select  Esc:back",
  welcome: "j/k:navigate  Enter:select  ?:details  q:quit",
} as const;

const ZOOM_LABELS: Readonly<Record<ZoomLevel, string>> = {
  normal: "NORMAL",
  half: "HALF",
  full: "FULL",
} as const;

/** View display names for the tab bar. */
const VIEW_LABELS: Readonly<Partial<Record<TuiView, string>>> = {
  agents: "Agents",
  console: "Console",
  forge: "Forge",
  datasources: "Sources",
  sessions: "Sessions",
} as const;

export interface StatusBarViewProps {
  readonly state: TuiState;
}

/** Status bar v2 — two-line header across the top of every view. */
export function StatusBarView(props: StatusBarViewProps): React.ReactNode {
  const { state } = props;
  const conn = useMemo(
    () => connectionStatusConfig(state.connectionStatus),
    [state.connectionStatus],
  );
  const agentCount = state.agents.length;
  const zoomLabel = ZOOM_LABELS[state.zoomLevel];
  const hint = VIEW_HINTS[state.view];
  const isWelcome = state.view === "welcome" || state.view === "presetdetail";

  return (
    <box height={2} flexDirection="column" backgroundColor={COLORS.bg}>
      {/* Line 1: tabs + status
       *
       * Note: <tab-select> was evaluated here but intentionally skipped.
       * The view tabs are display-only indicators — view switching is driven
       * by keyboard shortcuts and the command palette, not by clicking tabs.
       * Using <tab-select> would introduce unwanted interactive focus
       * management and key handling that conflicts with the existing
       * keyboard-driven navigation model.
       */}
      <box height={1} flexDirection="row">
        <text fg={COLORS.cyan}><b>{` [${zoomLabel}] `}</b></text>
        {!isWelcome && (
          <>
            {Object.entries(VIEW_LABELS).map(([viewKey, label]) => {
              const isActive = state.view === viewKey ||
                (state.view === "palette" && (
                  (viewKey === "console" && state.activeSession !== null) ||
                  (viewKey === "agents" && state.activeSession === null)
                ));
              return (
                <text key={viewKey} fg={isActive ? COLORS.white : COLORS.dim}>
                  {` ${label as string} `}
                  {isActive ? "·" : " "}
                </text>
              );
            })}
            <box flexGrow={1} />
            <text fg={conn.color}>{` ${conn.indicator}`}</text>
            <text fg={COLORS.dim}>{" │ "}</text>
            <text fg={COLORS.white}>{`${String(agentCount)} agents`}</text>
            {state.activeSession !== null && (() => {
              const session = state.activeSession;
              if (session === null) return null;
              const agent = state.agents.find((a) => a.agentId === session.agentId);
              const name = agent !== undefined ? agent.name : session.agentId;
              return (
                <>
                  <text fg={COLORS.dim}>{" │ "}</text>
                  <text fg={COLORS.cyan}>{name}</text>
                </>
              );
            })()}
            <text>{" "}</text>
          </>
        )}
        {isWelcome && (
          <>
            <text fg={COLORS.cyan}>{" Koi Setup"}</text>
            <box flexGrow={1} />
          </>
        )}
      </box>
      {/* Line 2: context-sensitive hints */}
      <box height={1} flexDirection="row">
        <text fg={COLORS.dim}>{` ${hint}`}</text>
      </box>
    </box>
  );
}
