import { PanelChrome } from "../components/panel-chrome.js";
import type { ChannelsViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface ChannelsViewProps {
  readonly channelsView: ChannelsViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function ChannelsView(props: ChannelsViewProps): React.ReactNode {
  const { events, scrollOffset } = props.channelsView;
  const VISIBLE_ROWS = 20;
  const visible = events.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Channels"
      count={events.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={events.length === 0}
      emptyMessage="No channel events yet."
      emptyHint="Channels connect agents to I/O sources (CLI, Slack, Discord)."
    >
      <box flexDirection="column">
        <box height={1}>
          <text fg={COLORS.dim}>{" Event              Channel              Type         Time"}</text>
        </box>
        {visible.map((event, i) => {
          const time = new Date(event.timestamp).toLocaleTimeString();
          const channelId = event.channelId.padEnd(20).slice(0, 20);
          const subKind = event.subKind.padEnd(18);
          const channelType = "channelType" in event ? (event.channelType as string).padEnd(12).slice(0, 12) : "".padEnd(12);
          return (
            <box key={`${event.channelId}-${String(i)}`} height={1}>
              <text>{` ${subKind} ${channelId} ${channelType} ${time}`}</text>
            </box>
          );
        })}
      </box>
    </PanelChrome>
  );
}
