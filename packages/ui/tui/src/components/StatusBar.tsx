/**
 * StatusBar — top/bottom status line for the TUI.
 */

import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
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

function AgentStatusChip(props: {
  readonly status: AgentStatus;
  readonly elapsed: number;
}): JSX.Element {
  const label = () => {
    if (props.status === "processing") {
      return props.elapsed > 0 ? `streaming… ${props.elapsed}s` : "streaming…";
    }
    return props.status === "idle" ? "idle" : "error";
  };
  return <text fg={STATUS_COLORS[props.status]}>{label()}</text>;
}

export interface StatusBarProps {
  readonly width?: number | undefined;
}

export function StatusBar(props: StatusBarProps): JSX.Element {
  const sessionInfo = useTuiStore((s) => s.sessionInfo);
  const cumulativeMetrics = useTuiStore((s) => s.cumulativeMetrics);
  const agentStatus = useTuiStore((s) => s.agentStatus);
  const maxContextTokens = useTuiStore((s) => s.maxContextTokens);
  const retryState = useTuiStore((s) => s.retryState);
  const agentDepth = useTuiStore((s) => s.agentDepth);
  const siblingInfo = useTuiStore((s) => s.siblingInfo);

  // Elapsed timer during streaming (like Claude Code's status line)
  const [elapsed, setElapsed] = createSignal(0);
  createEffect(
    on(agentStatus, (st: AgentStatus) => {
      if (st === "processing") {
        const start = Date.now();
        setElapsed(0);
        const id = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
        onCleanup(() => clearInterval(id));
      } else {
        setElapsed(0);
      }
    }),
  );

  const showMetrics = createMemo(() => (props.width ?? 80) >= 60);
  const turnsLabel = createMemo(() => {
    const m = cumulativeMetrics();
    return m.engineTurns > m.turns ? "T" + m.turns + "·" + m.engineTurns : "T" + m.turns;
  });

  // #17: context usage percentage
  const contextPct = createMemo(() => {
    const max = maxContextTokens();
    if (!max) return null;
    const used = cumulativeMetrics().totalTokens;
    return Math.min(100, Math.round((used / max) * 100));
  });

  // #4: subagent footer label
  const subagentLabel = createMemo(() => {
    const depth = agentDepth();
    if (depth === 0) return null;
    const sib = siblingInfo();
    return sib ? `Subagent (${sib.current} of ${sib.total})` : `Subagent (depth ${depth})`;
  });

  return (
    <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1} gap={2}>
      <ModelChip info={sessionInfo()} />
      {showMetrics() ? <MetricsChip metrics={cumulativeMetrics()} /> : null}
      {/* #17 context usage indicator */}
      <Show when={contextPct() !== null}>
        <text fg={COLORS.textMuted}>{`ctx ${contextPct()}%`}</text>
      </Show>
      {/* #4 subagent depth */}
      <Show when={subagentLabel() !== null}>
        <text fg={COLORS.amber}>{subagentLabel()}</text>
      </Show>
      <box flexGrow={1} />
      {/* #20 retry countdown */}
      <Show when={retryState() !== null}>
        <text fg={COLORS.amber}>{`Retrying in ${retryState()?.countdownSec}s (attempt ${retryState()?.attempt})`}</text>
      </Show>
      <AgentStatusChip status={agentStatus()} elapsed={elapsed()} />
      <text fg={COLORS.textMuted}>{turnsLabel()}</text>
    </box>
  );
}
