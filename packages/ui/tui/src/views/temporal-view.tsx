/**
 * Temporal view — workflow lifecycle observability.
 *
 * Shows Temporal health, workflow list, detail with timeline.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import type { TemporalViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface TemporalViewProps {
  readonly temporalView: TemporalViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

const STATUS_COLORS: Readonly<Record<string, string>> = {
  running: COLORS.green,
  completed: COLORS.dim,
  failed: COLORS.red,
  cancelled: COLORS.yellow,
  terminated: COLORS.red,
  timed_out: COLORS.yellow,
} as const;

export function TemporalView(props: TemporalViewProps): React.ReactNode {
  const { health, workflows, selectedWorkflowIndex, workflowDetail, events, scrollOffset } =
    props.temporalView;
  const VISIBLE_ROWS = 15;
  const visible = workflows.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Temporal"
      count={workflows.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={health === null && workflows.length === 0 && events.length === 0}
      emptyMessage="No Temporal data yet."
      emptyHint="Temporal orchestrates long-running agent workflows."
    >
      {/* Health bar */}
      {health !== null && (
        <box height={1} flexDirection="row">
          <text fg={health.healthy ? COLORS.green : COLORS.red}>
            {` ${health.healthy ? "●" : "○"} ${health.serverAddress} (${health.namespace})`}
          </text>
          {health.latencyMs !== undefined && (
            <text fg={COLORS.dim}>{` │ ${String(health.latencyMs)}ms`}</text>
          )}
        </box>
      )}

      {/* Workflow detail (if selected) */}
      {workflowDetail !== null && (
        <box flexDirection="column" marginTop={1}>
          <box height={1}>
            <text fg={COLORS.cyan}><b>{` Workflow: ${workflowDetail.workflowId}`}</b></text>
          </box>
          <box height={1}>
            <text>{` Type: ${workflowDetail.workflowType} │ Run: ${workflowDetail.runId.slice(0, 12)}…`}</text>
          </box>
          <box height={1}>
            <text>
              {` Status: ${workflowDetail.status} │ Activities: ${String(workflowDetail.pendingActivities)} │ Signals: ${String(workflowDetail.pendingSignals)} │ CAN: ${String(workflowDetail.canCount)}`}
            </text>
          </box>
          {workflowDetail.timeline !== undefined && workflowDetail.timeline.length > 0 && (
            <box flexDirection="column" marginTop={1}>
              <box height={1}><text fg={COLORS.dim}>{" Timeline:"}</text></box>
              {workflowDetail.timeline.slice(-10).map((evt, i) => (
                <box key={`tl-${String(i)}`} height={1}>
                  <text fg={COLORS.dim}>
                    {`   ${new Date(evt.time).toLocaleTimeString()} [${evt.category}] ${evt.label}`}
                  </text>
                </box>
              ))}
            </box>
          )}
        </box>
      )}

      {/* Workflow list */}
      {workflowDetail === null && (
        <box flexDirection="column" marginTop={health !== null ? 1 : 0}>
          <box height={1}>
            <text fg={COLORS.dim}>{" Workflow             Type                 Status      Start"}</text>
          </box>
          {visible.map((wf, i) => {
            const actualIdx = scrollOffset + i;
            const isSelected = actualIdx === selectedWorkflowIndex;
            const statusColor = STATUS_COLORS[wf.status] ?? COLORS.white;
            const time = new Date(wf.startTime).toLocaleTimeString();
            return (
              <box key={wf.workflowId} height={1}>
                <text {...(isSelected ? { fg: COLORS.cyan } : {})}>
                  {isSelected ? " >" : "  "}
                </text>
                <text>
                  {`${wf.workflowId.padEnd(20).slice(0, 20)} ${wf.workflowType.padEnd(20).slice(0, 20)} `}
                </text>
                <text fg={statusColor}>{wf.status.padEnd(12)}</text>
                <text>{time}</text>
              </box>
            );
          })}
        </box>
      )}

      {/* Event log (below list) */}
      {events.length > 0 && workflowDetail === null && (
        <box flexDirection="column" marginTop={1}>
          <box height={1}><text fg={COLORS.dim}>{` Recent events (${String(events.length)}):`}</text></box>
          {events.slice(-5).map((evt, i) => {
            const time = new Date(evt.timestamp).toLocaleTimeString();
            const detail = evt.subKind === "health_changed"
              ? `healthy: ${String(evt.healthy)}`
              : "workflowId" in evt ? (evt as { readonly workflowId: string }).workflowId : "";
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
