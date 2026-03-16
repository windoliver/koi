/**
 * Harness view — long-running agent orchestration status.
 *
 * Shows phase indicator, progress bars, checkpoint timeline.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import type { HarnessViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface HarnessViewProps {
  readonly harnessView: HarnessViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

/** Render a simple ASCII progress bar. */
function progressBar(current: number, total: number, width: number): string {
  if (total === 0) return "░".repeat(width);
  const ratio = Math.min(1, current / total);
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

const PHASE_COLORS: Readonly<Record<string, string>> = {
  idle: COLORS.dim,
  running: COLORS.green,
  paused: COLORS.yellow,
  completed: COLORS.cyan,
  failed: COLORS.red,
} as const;

export function HarnessView(props: HarnessViewProps): React.ReactNode {
  const { status, checkpoints, events, scrollOffset } = props.harnessView;
  const VISIBLE_ROWS = 15;
  const visibleCheckpoints = checkpoints.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Harness"
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={status === null && events.length === 0}
      emptyMessage="No harness data yet."
      emptyHint="The harness orchestrates long-running agent sessions."
    >
      {/* Phase indicator */}
      {status !== null && (
        <box flexDirection="column">
          <box height={1}>
            <text fg={PHASE_COLORS[status.phase] ?? COLORS.white}>
              {` Phase: ${status.phase.toUpperCase()}`}
            </text>
            <text fg={COLORS.dim}>
              {` │ Sessions: ${String(status.sessionCount)} │ Auto-resume: ${status.autoResumeEnabled ? "on" : "off"}`}
            </text>
          </box>

          {/* Task progress bar */}
          <box height={1}>
            <text fg={COLORS.dim}>{" Tasks: "}</text>
            <text fg={COLORS.cyan}>
              {progressBar(status.taskProgress.completed, status.taskProgress.total, 30)}
            </text>
            <text>{` ${String(status.taskProgress.completed)}/${String(status.taskProgress.total)}`}</text>
          </box>

          {/* Token usage bar */}
          <box height={1}>
            <text fg={COLORS.dim}>{" Token: "}</text>
            <text fg={status.tokenUsage.used > status.tokenUsage.budget * 0.9 ? COLORS.red : COLORS.cyan}>
              {progressBar(status.tokenUsage.used, status.tokenUsage.budget, 30)}
            </text>
            <text>{` ${String(status.tokenUsage.used)}/${String(status.tokenUsage.budget)}`}</text>
          </box>
        </box>
      )}

      {/* Checkpoint timeline */}
      {visibleCheckpoints.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <box height={1}>
            <text fg={COLORS.dim}>{` Checkpoints (${String(checkpoints.length)}):`}</text>
          </box>
          {visibleCheckpoints.map((cp) => {
            const time = new Date(cp.createdAt).toLocaleTimeString();
            const icon = cp.type === "hard" ? "◆" : "◇";
            return (
              <box key={cp.id} height={1}>
                <text>
                  {`   ${icon} ${time} [${cp.type}]${cp.sessionId !== undefined ? ` session: ${cp.sessionId.slice(0, 12)}` : ""}`}
                </text>
              </box>
            );
          })}
        </box>
      )}

      {/* Event log */}
      {events.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <box height={1}><text fg={COLORS.dim}>{` Events (${String(events.length)}):`}</text></box>
          {events.slice(-5).map((evt, i) => {
            const time = new Date(evt.timestamp).toLocaleTimeString();
            const detail = evt.subKind === "phase_changed"
              ? `${evt.from} → ${evt.to}`
              : `[${evt.checkpointType}]`;
            return (
              <box key={`evt-${String(i)}`} height={1}>
                <text fg={COLORS.dim}>{`   ${time} ${evt.subKind} ${detail}`}</text>
              </box>
            );
          })}
        </box>
      )}
    </PanelChrome>
  );
}
