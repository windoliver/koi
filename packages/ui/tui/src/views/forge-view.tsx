/**
 * Forge view — self-improvement observability panel for the TUI.
 *
 * Shows active bricks with fitness sparklines, demand signal counts,
 * monitor anomalies, and policy promotion stats.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import { sparkline } from "../lib/sparkline.js";
import type { ForgeDashboardEvent, MonitorDashboardEvent } from "@koi/dashboard-types";
import type { LayoutTier, TuiBrickSummary } from "../state/types.js";
import { COLORS, truncate } from "../theme.js";

/** Typed forge view state slice (avoids passing full TuiState). */
export interface ForgeViewState {
  readonly forgeBricks: Readonly<Record<string, TuiBrickSummary>>;
  readonly forgeSparklines: Readonly<Record<string, readonly number[]>>;
  readonly forgeEvents: readonly ForgeDashboardEvent[];
  readonly monitorEvents: readonly MonitorDashboardEvent[];
  readonly forgeSelectedBrickIndex: number;
}

export interface ForgeViewProps {
  readonly state: ForgeViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
  readonly layoutTier?: LayoutTier | undefined;
}

export function ForgeView(props: ForgeViewProps): React.ReactNode {
  const { forgeBricks, forgeSparklines, forgeEvents, monitorEvents, forgeSelectedBrickIndex } = props.state;
  const brickEntries = Object.entries(forgeBricks);
  const selectedIdx = forgeSelectedBrickIndex;
  const isNarrow = props.layoutTier === "narrow" || props.layoutTier === "tooNarrow";
  const nameWidth = isNarrow ? 16 : 20;

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
      emptyHint="Ask your agent to do something it can't — it'll forge a tool."
    >
      {/* Summary counters */}
      <box height={1} flexDirection="row">
        <text fg={COLORS.dim}>
          {` Demands: ${String(demandCount)} (${lastDemandKind}) │ Anomalies: ${String(anomalyCount)} (${lastAnomalyKind}) │ Promoted: `}
        </text>
        <text fg={COLORS.accent}>{String(promotedCount)}</text>
      </box>

      {/* Brick table */}
      <box flexDirection="column">
        <box height={1}>
          <text fg={COLORS.dim}>{` ${"Name".padEnd(nameWidth)} Status       Fitness`}</text>
        </box>
        {brickEntries.map(([brickId, brick], i) => {
          const fitnessData = forgeSparklines[brickId] ?? [];
          const fitnessLabel = brick.fitness > 0 ? `${(brick.fitness * 100).toFixed(0)}%` : " —";
          const sparklineStr = !isNarrow && fitnessData.length > 0 ? ` ${sparkline(fitnessData)}` : "";
          const isSelected = i === selectedIdx;
          return (
            <box key={brickId} height={1} flexDirection="row">
              <text {...(isSelected ? { fg: COLORS.cyan } : {})}>
                {isSelected ? " >" : "  "}
                {`${truncate(brick.name, nameWidth)} ${brick.status.padEnd(12)} ${fitnessLabel}${sparklineStr}`}
              </text>
            </box>
          );
        })}
      </box>
    </PanelChrome>
  );
}
