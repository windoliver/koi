/**
 * StatusBar — top/bottom status line for the TUI.
 *
 * Displays: model/provider · token usage · cost · session name ·
 *           agent status · turn counter.
 *
 * Pure renderer: reads state via useTuiStore selector; no local state.
 * Updates only when the selected slice changes (once per turn, not per chunk).
 */

import React, { memo } from "react";
import { useTuiStore } from "../store-context.js";
import type { AgentStatus, CumulativeMetrics, SessionInfo } from "../state/types.js";
import { formatCost, formatTokens } from "./status-bar-helpers.js";

export { formatCost, formatTokens };

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: "#4ADE80",       // green
  processing: "#FBBF24", // amber
  error: "#F87171",      // red
};

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: "idle",
  processing: "streaming…",
  error: "error",
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ModelChip({ info }: { readonly info: SessionInfo | null }): React.ReactNode {
  if (!info) return <text fg="#64748B">{"no session"}</text>;
  return (
    <text fg="#94A3B8">
      {info.modelName}
      <text fg="#64748B">{" · "}</text>
      {info.provider}
    </text>
  );
}

function MetricsChip({ metrics }: { readonly metrics: CumulativeMetrics }): React.ReactNode {
  const { totalTokens, inputTokens, outputTokens, costUsd } = metrics;
  if (totalTokens === 0) return <text fg="#64748B">{"—"}</text>;
  return (
    <text fg="#94A3B8">
      {`↑${formatTokens(inputTokens)} ↓${formatTokens(outputTokens)} · ${formatCost(costUsd)}`}
    </text>
  );
}

function AgentStatusChip({ status }: { readonly status: AgentStatus }): React.ReactNode {
  return <text fg={STATUS_COLORS[status]}>{STATUS_LABELS[status]}</text>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface StatusBarProps {
  /** Width of the terminal — used to decide how much to show. */
  readonly width?: number | undefined;
}

export const StatusBar: React.NamedExoticComponent<StatusBarProps> = memo(function StatusBar(
  props: StatusBarProps,
): React.ReactNode {
  const { width = 80 } = props;

  const sessionInfo = useTuiStore((s) => s.sessionInfo);
  const cumulativeMetrics = useTuiStore((s) => s.cumulativeMetrics);
  const agentStatus = useTuiStore((s) => s.agentStatus);
  const turns = useTuiStore((s) => s.cumulativeMetrics.turns);
  const engineTurns = useTuiStore((s) => s.cumulativeMetrics.engineTurns);

  // Compact mode: skip metrics chip when terminal is narrow
  const showMetrics = width >= 60;

  // Show "T3" when model calls = user turns (normal), "T1·5" when a run had
  // internal tool-loop/retry amplification (engineTurns > turns).
  const turnsLabel =
    engineTurns > turns ? `T${turns}·${engineTurns}` : `T${turns}`;

  return (
    <box
      flexDirection="row"
      width="100%"
      paddingLeft={1}
      paddingRight={1}
      bg="#1E293B"
      gap={2}
    >
      <ModelChip info={sessionInfo} />
      {showMetrics ? <MetricsChip metrics={cumulativeMetrics} /> : null}
      <box flexGrow={1} />
      <AgentStatusChip status={agentStatus} />
      <text fg="#64748B">{turnsLabel}</text>
    </box>
  );
});
