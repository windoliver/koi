/**
 * Status bar OpenTUI component — renders connection status, agent info, and hints.
 *
 * Uses Box + Text intrinsics from @opentui/solid.
 * Derives display data from TuiState accessor.
 */

import type { JSX } from "@opentui/solid";
import type { Accessor } from "solid-js";
import { COLORS, connectionStatusConfig } from "../theme.js";
import type { TuiState, TuiView } from "../state/types.js";

/** View-specific keyboard hints. */
const VIEW_HINTS: Readonly<Record<TuiView, string>> = {
  agents: "↑↓ navigate  Enter select  Ctrl+P commands  q quit",
  console: "Type message  Enter send  Esc back  Ctrl+P commands",
  palette: "↑↓ navigate  Enter select  Esc close",
  sessions: "↑↓ navigate  Enter select  Esc back",
} as const;

/** Props for the StatusBarView component. */
export interface StatusBarViewProps {
  readonly state: Accessor<TuiState>;
}

/** Status bar — single-line header across the top of every view. */
export function StatusBarView(props: StatusBarViewProps): JSX.Element {
  const conn = () => connectionStatusConfig(props.state().connectionStatus);
  const agentCount = () => props.state().agents.length;
  const agentName = () => {
    const session = props.state().activeSession;
    if (session === null) return "no agent";
    const agent = props.state().agents.find((a) => a.agentId === session.agentId);
    return agent !== undefined ? agent.name : session.agentId;
  };
  const hint = () => VIEW_HINTS[props.state().view];

  return (
    <box height={1} flexDirection="row" backgroundColor={COLORS.bg}>
      <text fg={COLORS.cyan}><b>{" KOI "}</b></text>
      <text fg={conn().color}>{` ${conn().indicator}`}</text>
      <text fg={COLORS.dim}>{" │ "}</text>
      <text fg={COLORS.white}>{`${String(agentCount())} agents`}</text>
      <text fg={COLORS.dim}>{" │ "}</text>
      <text fg={COLORS.cyan}>{agentName()}</text>
      <text fg={COLORS.dim}>{" │ "}</text>
      <text fg={COLORS.dim}>{hint()}</text>
    </box>
  );
}
