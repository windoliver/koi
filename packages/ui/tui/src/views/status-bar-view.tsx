/**
 * Status bar OpenTUI component — renders connection status, agent info, and hints.
 *
 * Uses Box + Text intrinsics from @opentui/react.
 * Derives display data from TuiState prop.
 */

import { useMemo } from "react";
import { COLORS, connectionStatusConfig } from "../theme.js";
import type { TuiState, TuiView } from "../state/types.js";

/** View-specific keyboard hints. */
const VIEW_HINTS: Readonly<Record<TuiView, string>> = {
  agents: "↑↓ navigate  Enter select  Ctrl+P commands  q quit",
  consent: "[y] approve  [n] deny  [d] details  Esc dismiss",
  console: "Type message  Enter send  Esc back  Ctrl+P commands",
  datasources: "↑↓ navigate  [a] approve  [s] schema  Esc back",
  sourcedetail: "Esc back  [a] approve",
  palette: "↑↓ navigate  Enter select  Esc close",
  sessions: "↑↓ navigate  Enter select  Esc back",
} as const;

/** Props for the StatusBarView component. */
export interface StatusBarViewProps {
  readonly state: TuiState;
}

/** Status bar — single-line header across the top of every view. */
export function StatusBarView(props: StatusBarViewProps): React.ReactNode {
  const conn = useMemo(
    () => connectionStatusConfig(props.state.connectionStatus),
    [props.state.connectionStatus],
  );
  const agentCount = props.state.agents.length;
  const agentName = useMemo(() => {
    const session = props.state.activeSession;
    if (session === null) return "no agent";
    const agent = props.state.agents.find((a) => a.agentId === session.agentId);
    return agent !== undefined ? agent.name : session.agentId;
  }, [props.state.activeSession, props.state.agents]);
  const hint = VIEW_HINTS[props.state.view];

  return (
    <box height={1} flexDirection="row" backgroundColor={COLORS.bg}>
      <text fg={COLORS.cyan}><b>{" KOI "}</b></text>
      <text fg={conn.color}>{` ${conn.indicator}`}</text>
      <text fg={COLORS.dim}>{" │ "}</text>
      <text fg={COLORS.white}>{`${String(agentCount)} agents`}</text>
      <text fg={COLORS.dim}>{" │ "}</text>
      <text fg={COLORS.cyan}>{agentName}</text>
      <text fg={COLORS.dim}>{" │ "}</text>
      <text fg={COLORS.dim}>{hint}</text>
    </box>
  );
}
