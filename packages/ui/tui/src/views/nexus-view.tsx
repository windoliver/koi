import { PanelChrome } from "../components/panel-chrome.js";
import type { NexusViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface NexusViewProps {
  readonly nexusView: NexusViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function NexusView(props: NexusViewProps): React.ReactNode {
  const { events, scrollOffset } = props.nexusView;
  const VISIBLE_ROWS = 20;
  const visible = events.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Nexus"
      count={events.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={events.length === 0}
      emptyMessage="No nexus events yet."
      emptyHint="Nexus is the shared backend for data and coordination."
    >
      <box flexDirection="column">
        <box height={1}>
          <text fg={COLORS.dim}>{" Event              Path / Agent             Time"}</text>
        </box>
        {visible.map((event, i) => {
          const time = new Date(event.timestamp).toLocaleTimeString();
          const subKind = event.subKind.padEnd(18);
          const detail = event.subKind === "file_changed"
            ? `${event.changeType} ${event.path}`.padEnd(24).slice(0, 24)
            : `agent: ${event.agentId}`.padEnd(24).slice(0, 24);
          return (
            <box key={`${event.subKind}-${String(i)}`} height={1}>
              <text>{` ${subKind} ${detail} ${time}`}</text>
            </box>
          );
        })}
      </box>
    </PanelChrome>
  );
}
