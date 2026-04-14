/**
 * CostDashboardView — "cost" screen (activeView === "cost").
 *
 * Renders real-time cost breakdown per model, tool, agent, and provider.
 * Data is injected by the host via `set_cost_breakdown` action.
 * Falls back to cumulative metrics when no breakdown is available.
 */

import { For, Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";
import { formatCost, formatTokens } from "./status-bar-helpers.js";

/**
 * Format a percentage for display — e.g. 0.4523 → "45.2%".
 */
function formatPct(value: number, total: number): string {
  if (total === 0) return "—";
  return `${((value / total) * 100).toFixed(1)}%`;
}

/**
 * Render a single row in a breakdown table.
 */
function BreakdownRow(props: {
  readonly label: string;
  readonly cost: number;
  readonly total: number;
  readonly tokens?: number | undefined;
  readonly calls?: number | undefined;
}): JSX.Element {
  return (
    <box flexDirection="row" gap={2}>
      <text fg={COLORS.white} width={24}>{props.label}</text>
      <text fg={COLORS.cyan} width={12}>{formatCost(props.cost)}</text>
      <text fg={COLORS.textMuted} width={8}>{formatPct(props.cost, props.total)}</text>
      <Show when={props.tokens !== undefined}>
        <text fg={COLORS.textSecondary} width={10}>{formatTokens(props.tokens ?? 0)}</text>
      </Show>
      <Show when={props.calls !== undefined}>
        <text fg={COLORS.dim}>{`${props.calls} calls`}</text>
      </Show>
    </box>
  );
}

function SectionHeader(props: { readonly title: string }): JSX.Element {
  return (
    <box marginTop={1}>
      <text fg={COLORS.amber}>{props.title}</text>
    </box>
  );
}

export function CostDashboardView(): JSX.Element {
  const costBreakdown = useTuiStore((s) => s.costBreakdown);
  const cumulativeMetrics = useTuiStore((s) => s.cumulativeMetrics);
  const tokenRate = useTuiStore((s) => s.tokenRate);

  const totalCost = createMemo(() => {
    const bd = costBreakdown();
    if (bd !== null) return bd.totalCostUsd;
    return cumulativeMetrics().costUsd ?? 0;
  });

  const hasBreakdown = createMemo(() => costBreakdown() !== null);

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      {/* Header */}
      <text fg={COLORS.cyan}>{"Cost Dashboard"}</text>
      <text>{" "}</text>

      {/* Total spend */}
      <box flexDirection="row" gap={2}>
        <text fg={COLORS.textMuted}>{"Total spend:"}</text>
        <text fg={COLORS.green}>{formatCost(totalCost())}</text>
        <text fg={COLORS.dim}>
          {`(${formatTokens(cumulativeMetrics().inputTokens)} in / ${formatTokens(cumulativeMetrics().outputTokens)} out)`}
        </text>
      </box>

      {/* Token rate */}
      <Show when={tokenRate() !== null}>
        <box flexDirection="row" gap={2}>
          <text fg={COLORS.textMuted}>{"Token rate:"}</text>
          <text fg={COLORS.textSecondary}>
            {`${formatTokens(Math.round(tokenRate()?.inputPerSecond ?? 0))}/s in · ${formatTokens(Math.round(tokenRate()?.outputPerSecond ?? 0))}/s out`}
          </text>
        </box>
      </Show>

      <Show
        when={hasBreakdown()}
        fallback={
          <box marginTop={1}>
            <text fg={COLORS.dim}>
              {"No detailed cost breakdown available yet. Cost data will appear after model calls."}
            </text>
          </box>
        }
      >
        {/* Per-model breakdown */}
        <Show when={(costBreakdown()?.byModel.length ?? 0) > 0}>
          <SectionHeader title="By Model" />
          <For each={costBreakdown()?.byModel ?? []}>
            {(m) => (
              <BreakdownRow
                label={m.model}
                cost={m.totalCostUsd}
                total={totalCost()}
                tokens={m.totalInputTokens + m.totalOutputTokens}
                calls={m.callCount}
              />
            )}
          </For>
        </Show>

        {/* Per-provider breakdown */}
        <Show when={(costBreakdown()?.byProvider?.length ?? 0) > 0}>
          <SectionHeader title="By Provider" />
          <For each={costBreakdown()?.byProvider ?? []}>
            {(p) => (
              <BreakdownRow
                label={p.provider}
                cost={p.totalCostUsd}
                total={totalCost()}
                tokens={p.totalInputTokens + p.totalOutputTokens}
                calls={p.callCount}
              />
            )}
          </For>
        </Show>

        {/* Per-agent breakdown */}
        <Show when={(costBreakdown()?.byAgent?.length ?? 0) > 0}>
          <SectionHeader title="By Agent" />
          <For each={costBreakdown()?.byAgent ?? []}>
            {(a) => (
              <BreakdownRow
                label={a.agentId}
                cost={a.totalCostUsd}
                total={totalCost()}
                tokens={a.totalInputTokens + a.totalOutputTokens}
                calls={a.callCount}
              />
            )}
          </For>
        </Show>

        {/* Per-tool breakdown */}
        <Show when={(costBreakdown()?.byTool.length ?? 0) > 0}>
          <SectionHeader title="By Tool" />
          <For each={costBreakdown()?.byTool ?? []}>
            {(t) => (
              <BreakdownRow
                label={t.toolName}
                cost={t.totalCostUsd}
                total={totalCost()}
                calls={t.callCount}
              />
            )}
          </For>
        </Show>
      </Show>

      {/* Footer */}
      <text>{" "}</text>
      <text fg={COLORS.fgDim}>{"Esc \u2192 back"}</text>
    </box>
  );
}
