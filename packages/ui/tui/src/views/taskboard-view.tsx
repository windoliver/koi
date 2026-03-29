/**
 * TaskBoard view — ASCII DAG with status-colored nodes, worker assignment,
 * output preview, and progress summary.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import type { TaskBoardViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface TaskBoardViewProps {
  readonly taskBoardView: TaskBoardViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

const VISIBLE_ROWS = 20;
const MAX_OUTPUT_PREVIEW = 60;

function statusColor(status: string): string {
  if (status === "completed") return COLORS.dim;
  if (status === "failed") return COLORS.red;
  if (status === "running") return COLORS.green;
  return COLORS.white;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

export function TaskBoardView(props: TaskBoardViewProps): React.ReactNode {
  const { snapshot, cachedLayout, events, scrollOffset } = props.taskBoardView;
  const layoutLines = cachedLayout ?? [];
  const visible = layoutLines.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  // Compute progress summary
  const nodes = snapshot?.nodes ?? [];
  const completedCount = nodes.filter((n) => n.status === "completed").length;
  const failedCount = nodes.filter((n) => n.status === "failed").length;
  const totalCount = nodes.length;

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
      {/* Progress summary bar */}
      {totalCount > 0 && (
        <box height={1} marginBottom={1}>
          <text fg={COLORS.dim}>
            {` Progress: ${String(completedCount)}/${String(totalCount)} done`}
            {failedCount > 0 ? ` (${String(failedCount)} failed)` : ""}
          </text>
        </box>
      )}

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

      {/* Node summary table with worker assignment and output preview */}
      {snapshot !== null && snapshot.nodes.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <box height={1}>
            <text fg={COLORS.dim}>
              {" Task                 Status       Worker           Output"}
            </text>
          </box>
          {snapshot.nodes.map((node) => {
            const sc = statusColor(node.status);
            const worker = node.assignedTo ?? "\u2014";
            const outputPreview =
              node.result !== undefined && typeof node.result === "string"
                ? truncate(node.result, MAX_OUTPUT_PREVIEW)
                : node.error !== undefined
                  ? truncate(`err: ${node.error}`, MAX_OUTPUT_PREVIEW)
                  : "\u2014";
            return (
              <box key={node.taskId} height={1}>
                <text>{` ${node.label.padEnd(20).slice(0, 20)} `}</text>
                <text fg={sc}>{node.status.padEnd(12)}</text>
                <text>{` ${worker.padEnd(16).slice(0, 16)} `}</text>
                <text fg={node.error !== undefined ? COLORS.red : COLORS.dim}>
                  {outputPreview}
                </text>
              </box>
            );
          })}
        </box>
      )}
    </PanelChrome>
  );
}
