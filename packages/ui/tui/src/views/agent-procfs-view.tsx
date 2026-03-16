import { PanelChrome } from "../components/panel-chrome.js";
import type { AgentProcfsViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface AgentProcfsViewProps {
  readonly agentProcfsView: AgentProcfsViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function AgentProcfsView(props: AgentProcfsViewProps): React.ReactNode {
  const { procfs, loading } = props.agentProcfsView;

  return (
    <PanelChrome
      title="Agent Procfs"
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      loading={loading}
      isEmpty={procfs === null && !loading}
      emptyMessage="No agent procfs data."
      emptyHint="Select an agent to view its runtime state."
    >
      {procfs !== null && (
        <box flexDirection="column" paddingLeft={1}>
          <box height={1}><text fg={COLORS.cyan}><b>{` ${procfs.name}`}</b></text></box>
          <box height={1}><text>{` ID:        ${String(procfs.agentId)}`}</text></box>
          <box height={1}><text>{` State:     ${procfs.state}`}</text></box>
          <box height={1}><text>{` Type:      ${procfs.agentType}`}</text></box>
          {procfs.model !== undefined && (
            <box height={1}><text>{` Model:     ${procfs.model}`}</text></box>
          )}
          <box height={1}><text>{` Turns:     ${String(procfs.turns)}`}</text></box>
          <box height={1}><text>{` Tokens:    ${String(procfs.tokenCount)}`}</text></box>
          <box height={1}><text>{` Channels:  ${procfs.channels.join(", ") || "none"}`}</text></box>
          <box height={1}><text>{` Children:  ${String(procfs.childCount)}`}</text></box>
          {procfs.parentId !== undefined && (
            <box height={1}><text>{` Parent:    ${String(procfs.parentId)}`}</text></box>
          )}
          <box height={1}>
            <text fg={COLORS.dim}>
              {` Started: ${new Date(procfs.startedAt).toLocaleTimeString()} │ Last: ${new Date(procfs.lastActivityAt).toLocaleTimeString()}`}
            </text>
          </box>
        </box>
      )}
    </PanelChrome>
  );
}
