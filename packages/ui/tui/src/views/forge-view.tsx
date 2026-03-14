/**
 * Forge view — self-improvement observability panel for the TUI.
 *
 * Shows active bricks with fitness sparklines, demand signal counts,
 * monitor anomalies, and policy promotion stats.
 */

import { sparkline } from "../lib/sparkline.js";
import type { TuiState } from "../state/types.js";
import { COLORS } from "../theme.js";

export interface ForgeViewProps {
  readonly state: TuiState;
  readonly focused: boolean;
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
    <box flexGrow={1} flexDirection="column">
      <box height={1} flexDirection="row">
        <text fg={COLORS.cyan}><b>{" Forge"}</b></text>
        <text fg={COLORS.dim}>{` (${String(brickEntries.length)} bricks)`}</text>
      </box>

      {/* Summary counters */}
      <box height={1} flexDirection="row">
        <text fg={COLORS.dim}>
          {` Demands: ${String(demandCount)} (${lastDemandKind}) │ Anomalies: ${String(anomalyCount)} (${lastAnomalyKind}) │ Promoted: ${String(promotedCount)}`}
        </text>
      </box>

      {/* Brick table */}
      {brickEntries.length === 0 ? (
        <box height={1}>
          <text fg={COLORS.dim}>{" No bricks forged yet."}</text>
        </box>
      ) : (
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
      )}
    </box>
  );
}
