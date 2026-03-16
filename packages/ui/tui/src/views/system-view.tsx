import { PanelChrome } from "../components/panel-chrome.js";
import type { SystemViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface SystemViewProps {
  readonly systemView: SystemViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function SystemView(props: SystemViewProps): React.ReactNode {
  const { events, scrollOffset } = props.systemView;
  const VISIBLE_ROWS = 20;
  const visible = events.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  // Count warnings
  let warningCount = 0;
  let errorCount = 0;
  for (const event of events) {
    if (event.subKind === "memory_warning") warningCount++;
    if (event.subKind === "error") errorCount++;
  }

  return (
    <PanelChrome
      title="System"
      count={events.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={events.length === 0}
      emptyMessage="No system events yet."
      emptyHint="System events include memory warnings, errors, and activity."
    >
      <box height={1} flexDirection="row">
        <text fg={COLORS.dim}>
          {` Warnings: ${String(warningCount)} │ Errors: ${String(errorCount)}`}
        </text>
      </box>
      <box flexDirection="column">
        <box height={1}>
          <text fg={COLORS.dim}>{" Type              Message                          Time"}</text>
        </box>
        {visible.map((event, i) => {
          const time = new Date(event.timestamp).toLocaleTimeString();
          const subKind = event.subKind.padEnd(16);
          const message = "message" in event
            ? (event.message as string).padEnd(32).slice(0, 32)
            : event.subKind === "memory_warning"
              ? `Heap: ${String(event.heapUsedMb)}/${String(event.heapLimitMb)}MB`.padEnd(32)
              : "".padEnd(32);
          return (
            <box key={`${event.subKind}-${String(i)}`} height={1}>
              <text>{` ${subKind} ${message} ${time}`}</text>
            </box>
          );
        })}
      </box>
    </PanelChrome>
  );
}
