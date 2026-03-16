/**
 * Forge view — self-improvement observability panel for the TUI.
 *
 * Shows active bricks with fitness sparklines, demand signal counts,
 * monitor anomalies, and policy promotion stats.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import { sparkline } from "../lib/sparkline.js";
import type { ForgeDashboardEvent, MonitorDashboardEvent } from "@koi/dashboard-types";
import type { TuiBrickSummary } from "../state/types.js";
import { COLORS } from "../theme.js";

/** Typed forge view state slice (avoids passing full TuiState). */
export interface ForgeViewState {
  readonly forgeBricks: Readonly<Record<string, TuiBrickSummary>>;
  readonly forgeSparklines: Readonly<Record<string, readonly number[]>>;
  readonly forgeEvents: readonly ForgeDashboardEvent[];
  readonly monitorEvents: readonly MonitorDashboardEvent[];
}

export interface ForgeViewProps {
  readonly state: ForgeViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function ForgeView(props: ForgeViewProps): React.ReactNode {
  const { forgeBricks, forgeSparklines, forgeEvents, monitorEvents } = props.state;
  const brickEntries = Object.entries(forgeBricks);

  // Count promotions
  let promotedCount = 0;
  for (const [, brick] of brickEntries) {
    if (brick.status === "promoted") promotedCount++;
  }

  // Count demand signals
  let demandCount = 0;
  let lastDemandKind = "—";
  for (const event of forgeEvents) {
    if (event.subKind === "demand_detected") {
      demandCount++;
      lastDemandKind = (event as { readonly triggerKind: string }).triggerKind;
    }
  }

  // Count monitor anomalies
  const anomalyCount = monitorEvents.length;
  const lastAnomalyKind =
    monitorEvents.length > 0
      ? monitorEvents[monitorEvents.length - 1]!.anomalyKind
      : "—";

  return (
    <PanelChrome
      title="Forge"
      count={brickEntries.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={brickEntries.length === 0}
      emptyMessage="No bricks forged yet."
      emptyHint="The forge creates reusable tools from agent behavior. Try the self-improvement demo pack."
    >
      {/* Summary counters */}
      <box height={1} flexDirection="row">
        <text fg={COLORS.dim}>
          {` Demands: ${String(demandCount)} (${lastDemandKind}) │ Anomalies: ${String(anomalyCount)} (${lastAnomalyKind}) │ Promoted: ${String(promotedCount)}`}
        </text>
      </box>

      {/* Brick table */}
      <box flexDirection="column">
        <box height={1}>
          <text fg={COLORS.dim}>{" Name                 Status       Fitness"}</text>
        </box>
        {brickEntries.map(([brickId, brick]) => {
          const fitnessData = forgeSparklines[brickId] ?? [];
          const fitnessLabel = brick.fitness > 0 ? `${(brick.fitness * 100).toFixed(0)}%` : " —";
          const sparklineStr = fitnessData.length > 0 ? ` ${sparkline(fitnessData)}` : "";
          return (
            <box key={brickId} height={1} flexDirection="row">
              <text>
                {` ${brick.name.padEnd(20).slice(0, 20)} ${brick.status.padEnd(12)} ${fitnessLabel}${sparklineStr}`}
              </text>
            </box>
          );
        })}
      </box>
    </PanelChrome>
  );
}
