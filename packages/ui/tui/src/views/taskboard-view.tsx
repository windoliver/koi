/**
 * TaskBoard view — ASCII DAG with status-colored nodes.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import type { TaskBoardViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface TaskBoardViewProps {
  readonly taskBoardView: TaskBoardViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function TaskBoardView(props: TaskBoardViewProps): React.ReactNode {
  const { snapshot, cachedLayout, events, scrollOffset } = props.taskBoardView;
  const VISIBLE_ROWS = 20;
  const layoutLines = cachedLayout ?? [];
  const visible = layoutLines.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Task Board"
      count={snapshot?.nodes.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={snapshot === null && events.length === 0}
      emptyMessage="No tasks queued."
      emptyHint="Use `/dispatch` to start a multi-agent task."
    >
      {/* DAG layout */}
      {visible.length > 0 && (
        <box flexDirection="column">
          {visible.map((line, i) => (
            <box key={`dag-${String(i)}`} height={1}>
              <text>{` ${line}`}</text>
            </box>
          ))}
        </box>
      )}

      {/* Node summary table */}
      {snapshot !== null && snapshot.nodes.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <box height={1}>
            <text fg={COLORS.dim}>{" Task                 Status       Assigned To"}</text>
          </box>
          {snapshot.nodes.map((node) => {
            const statusColor = node.status === "completed" ? COLORS.dim
              : node.status === "failed" ? COLORS.red
              : node.status === "running" ? COLORS.green
              : COLORS.white;
            return (
              <box key={node.taskId} height={1}>
                <text>{` ${node.label.padEnd(20).slice(0, 20)} `}</text>
                <text fg={statusColor}>{node.status.padEnd(12)}</text>
                <text>{node.assignedTo ?? "—"}</text>
              </box>
            );
          })}
        </box>
      )}
    </PanelChrome>
  );
}
