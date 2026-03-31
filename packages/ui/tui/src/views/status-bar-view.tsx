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
  addons: "j/k:navigate  Space:toggle  Enter:confirm  s:skip  Esc:back",
  agents: "↑↓:navigate  Enter:select  Ctrl+G:forge  Ctrl+P:commands  1-6:tabs  q:quit",
  agentprocfs: "Esc:back  Ctrl+P:commands",
  channels: "j/k:scroll  Esc:back  Ctrl+P:commands",
  consent: "[y] approve  [n] deny  [d] details  Esc:dismiss",
  console: "Type message  Enter:send  Esc:back  Ctrl+P:commands",
  cost: "j/k:scroll  Esc:back  Ctrl+P:commands",
  datasources: "↑↓:navigate  [a] approve  [s] schema  Esc:back",
  debug: "[1] inventory  [2] waterfall  [n/p] turn  j/k:scroll  Esc:back",
  delegation: "j/k:scroll  Esc:back  Ctrl+P:commands",
  doctor: "Esc:back",
  engine: "Enter:confirm  s:skip  Esc:back",
  files: "j/k:navigate  Enter:open  Esc:back  Ctrl+P:commands",
  forge: "j/k:navigate  [p] promote  [d] demote  [q] quarantine  Esc:back",
  gateway: "j/k:scroll  Esc:back  Ctrl+P:commands",
  governance: "j/k:navigate  [a] approve  [d] deny  Esc:back",
  handoffs: "j/k:scroll  Esc:back  Ctrl+P:commands",
  harness: "j/k:scroll  [p] pause/resume  Esc:back  Ctrl+P:commands",
  logs: "l:cycle-level  Esc:back",
  mailbox: "j/k:scroll  Esc:back  Ctrl+P:commands",
  middleware: "Esc:back  Ctrl+P:commands",
  model: "j/k:navigate  Enter:select  Esc:back",
  nameinput: "Enter:confirm  Esc:back",
  nexus: "j/k:scroll  Esc:back  Ctrl+F:close  Ctrl+P:commands",
  nexusconfig: "j/k:navigate  Enter:select  Esc:back",
  presetdetail: "Enter:select  Esc:back  q:quit",
  processtree: "j/k:scroll  Esc:back  Ctrl+P:commands",
  progress: "Starting Koi…",
  scheduler: "j/k:scroll  [r] retry DLQ  Esc:back  Ctrl+P:commands",
  scratchpad: "j/k:scroll  Enter:read  Esc:back  Ctrl+P:commands",
  service: "s:stop  d:doctor  l:logs  Esc:back",
  sourcedetail: "Esc:back  [a] approve",
  splitpanes: "Tab:focus-next  Enter:zoom  Esc:back  +:cycle-zoom",
  palette: "↑↓:navigate  Enter:select  Esc:close",
  sessions: "↑↓:navigate  Enter:select  Esc:back",
  skills: "j/k:scroll  Esc:back  Ctrl+P:commands",
  system: "j/k:scroll  Esc:back  Ctrl+P:commands",
  taskboard: "j/k:scroll  Esc:back  Ctrl+P:commands",
  temporal: "j/k:navigate  Enter:detail  [s] signal  [t] terminate  Esc:back",
  welcome: "j/k:navigate  Enter:select  ?:details  q:quit",
} as const;

const ZOOM_LABELS: Readonly<Record<ZoomLevel, string>> = {
  normal: "NORMAL",
  half: "HALF",
  full: "FULL",
} as const;

/** View display names for the tab bar (primary views only — keeps line 1 compact). */
const VIEW_LABELS: Readonly<Partial<Record<TuiView, string>>> = {
  agents: "1:Agents",
  console: "2:Console",
  forge: "3:Forge",
  datasources: "4:Sources",
  sessions: "5:Sessions",
  taskboard: "6:Tasks",
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
                <text key={viewKey} fg={isActive ? COLORS.accent : COLORS.dim}>
                  {` ${label as string} `}
                  {isActive ? "·" : " "}
                </text>
              );
            })}
            <box flexGrow={1} />
            {state.capabilities !== null && state.layoutTier === "full" && (
              <>
                <text fg={state.capabilities.nexus ? COLORS.green : COLORS.dim}>{state.capabilities.nexus ? "●" : "○"}</text>
                <text fg={state.capabilities.temporal ? COLORS.green : COLORS.dim}>{state.capabilities.temporal ? "●" : "○"}</text>
                <text fg={state.capabilities.scheduler ? COLORS.green : COLORS.dim}>{state.capabilities.scheduler ? "●" : "○"}</text>
                <text fg={state.capabilities.gateway ? COLORS.green : COLORS.dim}>{state.capabilities.gateway ? "●" : "○"}</text>
                <text fg={state.capabilities.harness ? COLORS.green : COLORS.dim}>{state.capabilities.harness ? "●" : "○"}</text>
              </>
            )}
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
