/**
 * Status bar — single-line header showing connection state + active agent.
 *
 * Renders as: ` KOI ` connection_status ` | ` agent_name ` | ` view_hint
 * Uses OpenTUI Box + Text components with inline styling.
 */

import type { ConnectionStatus, TuiView } from "../state/types.js";

/** Data needed to render the status bar. */
export interface StatusBarData {
  readonly connectionStatus: ConnectionStatus;
  readonly agentName: string | undefined;
  readonly view: TuiView;
  readonly agentCount: number;
}

/** View hint for each TUI screen. */
const VIEW_HINTS: Readonly<Record<TuiView, string>> = {
  addons: "j/k:navigate  Space:toggle  Enter:confirm  s:skip  Esc:back",
  agents: "↑↓:navigate  Enter:select  Ctrl+G:forge  Ctrl+P:commands  q:quit",
  channels: "j/k:navigate  Space:toggle  Enter:confirm  Esc:back",
  consent: "[y] approve  [n] deny  [d] details  Esc:dismiss",
  console: "Type message  Enter:send  Esc:back  Ctrl+P:commands",
  datasources: "↑↓:navigate  [a] approve  [s] schema  Esc:back",
  doctor: "Esc:back",
  engine: "Enter:confirm  s:skip  Esc:back",
  forge: "Esc:back  Ctrl+G:close  Ctrl+P:commands",
  logs: "l:cycle-level  Esc:back",
  model: "j/k:navigate  Enter:select  Esc:back",
  nameinput: "Enter:confirm  Esc:back",
  presetdetail: "Enter:select  Esc:back  q:quit",
  progress: "Starting Koi…",
  service: "s:stop  d:doctor  l:logs  Esc:back",
  sourcedetail: "Esc:back  [a] approve",
  splitpanes: "Tab:focus-next  Enter:zoom  Esc:back  +:cycle-zoom",
  palette: "↑↓:navigate  Enter:select  Esc:close",
  sessions: "↑↓:navigate  Enter:select  Esc:back",
  welcome: "j/k:navigate  Enter:select  ?:details  q:quit",
} as const;

/** Format connection status as indicator string. */
export function formatConnectionStatus(
  status: ConnectionStatus,
): { readonly indicator: string; readonly color: string } {
  switch (status) {
    case "connected":
      return { indicator: "● connected", color: "#00FF00" };
    case "reconnecting":
      return { indicator: "◌ reconnecting…", color: "#FFFF00" };
    case "disconnected":
      return { indicator: "○ disconnected", color: "#FF0000" };
  }
}

/** Format agent state as colored indicator. */
export function formatAgentState(
  state: "created" | "running" | "waiting" | "suspended" | "idle" | "terminated",
): string {
  return state;
}

/** Compose status bar text from data. */
export function composeStatusBarText(data: StatusBarData): string {
  const conn = formatConnectionStatus(data.connectionStatus);
  const agents = `${String(data.agentCount)} agents`;
  const agent = data.agentName ?? "no agent";
  const hint = VIEW_HINTS[data.view];

  return ` KOI  ${conn.indicator} │ ${agents} │ ${agent} │ ${hint}`;
}
