/**
 * Forge view — self-improvement observability panel for the TUI.
 *
 * Shows active bricks with fitness sparklines, demand signal counts,
 * monitor anomalies, and policy promotion stats. Includes a live
 * demand feed and color-coded status badges.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import { relativeTime } from "../lib/relative-time.js";
import { computeTrend, sparkline } from "../lib/sparkline.js";
import type { ForgeDashboardEvent, MonitorDashboardEvent } from "@koi/dashboard-types";
import type { LayoutTier, TuiBrickSummary } from "../state/types.js";
import { brickStatusConfig, COLORS, truncate } from "../theme.js";

/** Maximum number of events shown in the demand feed. */
const MAX_FEED_ITEMS = 5;

/** Map trend direction to a color for the sparkline. */
const TREND_COLORS = {
  rising: COLORS.cyan,
  declining: COLORS.yellow,
  flat: COLORS.dim,
} as const;

/** Map forge event subKind to a feed display icon. */
const EVENT_ICONS: Readonly<Record<string, string>> = {
  demand_detected: "⚡",
  brick_forged: "✓",
  brick_demand_forged: "✓",
  brick_promoted: "✓",
  brick_deprecated: "▼",
  brick_quarantined: "✕",
  crystallize_candidate: "◇",
  fitness_flushed: "●",
};

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

/** Extract a human-readable label from a forge event. */
function eventLabel(event: ForgeDashboardEvent): string {
  switch (event.subKind) {
    case "demand_detected":
      return `${event.triggerKind} needed`;
    case "brick_forged":
      return `${event.name} forged`;
    case "brick_demand_forged":
      return `${event.name} demand-forged`;
    case "brick_promoted":
      return `brick promoted`;
    case "brick_deprecated":
      return `brick deprecated`;
    case "brick_quarantined":
      return `brick quarantined`;
    case "crystallize_candidate":
      return `${event.suggestedName} candidate`;
    case "fitness_flushed":
      return `fitness updated`;
  }
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
      lastDemandKind = event.triggerKind;
    }
  }

  // Count monitor anomalies
  const anomalyCount = monitorEvents.length;

  // Recent feed events (last N, newest first)
  const feedEvents = forgeEvents.slice(-MAX_FEED_ITEMS).reverse();

  return (
    <PanelChrome
      title="Forge"
      count={brickEntries.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={brickEntries.length === 0}
      emptyMessage="No bricks forged yet."
      emptyHint="Ask your agent to do something it can't — it'll forge a tool for it."
    >
      {/* Summary counters */}
      <box height={1} flexDirection="row">
        <text fg={COLORS.dim}>
          {` Demands: ${String(demandCount)} (${lastDemandKind}) │ Anomalies: ${String(anomalyCount)} │ Promoted: `}
        </text>
        <text fg={COLORS.accent}>{String(promotedCount)}</text>
      </box>

      {/* Brick table */}
      <box flexDirection="column">
        <box height={1}>
          <text fg={COLORS.dim}>
            {isNarrow
              ? ` ${"Name".padEnd(nameWidth)} Status            Fitness`
              : ` ${"Name".padEnd(nameWidth)} Status            Fitness    Trend`}
          </text>
        </box>
        {brickEntries.map(([brickId, brick], i) => {
          const fitnessData = forgeSparklines[brickId] ?? [];
          const fitnessLabel = brick.fitness > 0 ? `${(brick.fitness * 100).toFixed(0)}%` : " —";
          const trend = computeTrend(fitnessData);
          const sparklineStr = !isNarrow && fitnessData.length > 0 ? ` ${sparkline(fitnessData)}` : "";
          const sparklineColor = TREND_COLORS[trend];
          const isSelected = i === selectedIdx;
          const badge = brickStatusConfig(brick.status);

          return (
            <box key={brickId} height={1} flexDirection="row">
              <text {...(isSelected ? { fg: COLORS.cyan } : {})}>
                {isSelected ? " ▸" : "  "}
                {` ${truncate(brick.name, nameWidth)} `}
              </text>
              <text fg={isSelected ? COLORS.cyan : badge.color}>
                {badge.label.padEnd(18).slice(0, 18)}
              </text>
              <text {...(isSelected ? { fg: COLORS.cyan } : {})}>
                {` ${fitnessLabel.padEnd(6)}`}
              </text>
              {sparklineStr.length > 0 && (
                <text fg={sparklineColor}>{sparklineStr}</text>
              )}
            </box>
          );
        })}
      </box>

      {/* Demand feed */}
      {feedEvents.length > 0 && (
        <box flexDirection="column">
          <box height={1}>
            <text fg={COLORS.dim}>{"────────────────────────────────────────"}</text>
          </box>
          <box height={1}>
            <text fg={COLORS.dim}>{" DEMAND FEED"}</text>
          </box>
          {feedEvents.map((event, i) => {
            const icon = EVENT_ICONS[event.subKind] ?? "·";
            const label = eventLabel(event);
            const timeStr = relativeTime(event.timestamp);
            return (
              <box key={`${event.subKind}-${String(event.timestamp)}-${String(i)}`} height={1}>
                <text fg={event.subKind === "demand_detected" ? COLORS.yellow : COLORS.dim}>
                  {`  ${icon} ${label.padEnd(28).slice(0, 28)} ${timeStr.padStart(8)}   ${event.subKind}`}
                </text>
              </box>
            );
          })}
        </box>
      )}
    </PanelChrome>
  );
}
