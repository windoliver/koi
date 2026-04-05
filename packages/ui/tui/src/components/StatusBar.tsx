/**
 * StatusBar — top/bottom status line for the TUI.
 */

import { createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";
import type { AgentStatus, CumulativeMetrics, SessionInfo } from "../state/types.js";
import { formatCost, formatTokens } from "./status-bar-helpers.js";

export { formatCost, formatTokens };

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: COLORS.success,
  processing: COLORS.amber,
  error: COLORS.danger,
};

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: "idle",
  processing: "streaming…",
  error: "error",
};

function ModelChip(props: { readonly info: SessionInfo | null }): JSX.Element {
  if (!props.info) return <text fg={COLORS.textMuted}>{"no session"}</text>;
  return (
    <box flexDirection="row">
      <text fg={COLORS.textSecondary}>{props.info.modelName}</text>
      <text fg={COLORS.textMuted}>{" · "}</text>
      <text fg={COLORS.textSecondary}>{props.info.provider}</text>
    </box>
  );
}

function MetricsChip(props: { readonly metrics: CumulativeMetrics }): JSX.Element {
  const total = () => props.metrics.totalTokens;
  return (
    <text fg={COLORS.textSecondary}>
      {total() === 0
        ? "—"
        : "up " +
          formatTokens(props.metrics.inputTokens) +
          " down " +
          formatTokens(props.metrics.outputTokens) +
          " · " +
          formatCost(props.metrics.costUsd)}
    </text>
  );
}

function AgentStatusChip(props: { readonly status: AgentStatus }): JSX.Element {
  return <text fg={STATUS_COLORS[props.status]}>{STATUS_LABELS[props.status]}</text>;
}

export interface StatusBarProps {
  readonly width?: number | undefined;
}

export function StatusBar(props: StatusBarProps): JSX.Element {
  const sessionInfo = useTuiStore((s) => s.sessionInfo);
  const cumulativeMetrics = useTuiStore((s) => s.cumulativeMetrics);
  const agentStatus = useTuiStore((s) => s.agentStatus);
  const showMetrics = createMemo(() => (props.width ?? 80) >= 60);
  const turnsLabel = createMemo(() => {
    const m = cumulativeMetrics();
    return m.engineTurns > m.turns ? "T" + m.turns + "·" + m.engineTurns : "T" + m.turns;
  });

  return (
    <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1} gap={2}>
      <ModelChip info={sessionInfo()} />
      {showMetrics() ? <MetricsChip metrics={cumulativeMetrics()} /> : null}
      <box flexGrow={1} />
      <AgentStatusChip status={agentStatus()} />
      <text fg={COLORS.textMuted}>{turnsLabel()}</text>
    </box>
  );
}
