import { PanelChrome } from "../components/panel-chrome.js";
import type { GatewayViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface GatewayViewProps {
  readonly gatewayView: GatewayViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function GatewayView(props: GatewayViewProps): React.ReactNode {
  const { events, scrollOffset, topology } = props.gatewayView;
  const VISIBLE_ROWS = 15;
  const visible = events.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Gateway"
      count={topology !== null ? topology.connections.length : events.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={events.length === 0 && topology === null}
      emptyMessage="No gateway data yet."
      emptyHint="The gateway manages channel connections and routing."
    >
      {/* Topology summary */}
      {topology !== null && (
        <box flexDirection="column">
          <box height={1}>
            <text fg={COLORS.dim}>
              {` Nodes: ${String(topology.nodeCount)} │ Connections: ${String(topology.connections.length)}`}
            </text>
          </box>
          <box height={1}>
            <text fg={COLORS.dim}>{" Channel              Type         Agent                Status"}</text>
          </box>
          {topology.connections.map((conn) => {
            const status = conn.connected ? "●" : "○";
            return (
              <box key={conn.channelId} height={1}>
                <text>
                  {` ${conn.channelId.padEnd(20).slice(0, 20)} ${conn.channelType.padEnd(12).slice(0, 12)} ${String(conn.agentId).padEnd(20).slice(0, 20)} ${status}`}
                </text>
              </box>
            );
          })}
        </box>
      )}

      {/* Event log */}
      {visible.length > 0 && (
        <box flexDirection="column" marginTop={topology !== null ? 1 : 0}>
          <box height={1}>
            <text fg={COLORS.dim}>{" Recent events:"}</text>
          </box>
          {visible.map((event, i) => {
            const time = new Date(event.timestamp).toLocaleTimeString();
            const detail = event.subKind === "connection_changed"
              ? `${event.channelId} ${event.connected ? "connected" : "disconnected"}`
              : `nodes: ${String(event.nodeCount)}, conns: ${String(event.connectionCount)}`;
            return (
              <box key={`${event.subKind}-${String(i)}`} height={1}>
                <text>{` ${event.subKind.padEnd(20)} ${detail.padEnd(40).slice(0, 40)} ${time}`}</text>
              </box>
            );
          })}
        </box>
      )}
    </PanelChrome>
  );
}
