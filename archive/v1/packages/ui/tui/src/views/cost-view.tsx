import { PanelChrome } from "../components/panel-chrome.js";
import type { CostViewState } from "../state/domain-types.js";
import type { LayoutTier } from "../state/types.js";
import type { AgentCostEntry, CascadeTierSummary, CircuitBreakerSummary } from "@koi/dashboard-types";
import { abbreviateModel, COLORS, separator, truncate } from "../theme.js";

export interface CostViewProps {
  readonly costView: CostViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
  readonly cols?: number | undefined;
  readonly layoutTier?: LayoutTier | undefined;
}

function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function budgetColor(used: number, limit: number): string {
  if (limit <= 0) return COLORS.dim;
  const pct = used / limit;
  if (pct >= 0.8) return COLORS.red;
  if (pct >= 0.5) return COLORS.yellow;
  return COLORS.green;
}

function circuitBreakerColor(state: CircuitBreakerSummary["state"]): string {
  if (state === "OPEN") return COLORS.red;
  if (state === "HALF_OPEN") return COLORS.yellow;
  return COLORS.green;
}

function budgetBar(used: number, limit: number, width: number): string {
  if (limit <= 0) return "░".repeat(width);
  const filled = Math.min(width, Math.round((used / limit) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function BudgetHeader(props: {
  readonly sessionUsed: number;
  readonly sessionLimit: number;
  readonly dailyUsed: number;
  readonly dailyLimit: number;
  readonly monthlyUsed: number;
  readonly monthlyLimit: number;
}): React.ReactNode {
  const line =
    ` Session: ${formatUsd(props.sessionUsed)} / ${formatUsd(props.sessionLimit)}` +
    `  Daily: ${formatUsd(props.dailyUsed)} / ${formatUsd(props.dailyLimit)}` +
    `  Monthly: ${formatUsd(props.monthlyUsed)} / ${formatUsd(props.monthlyLimit)}`;
  return (
    <box height={1}>
      <text fg={COLORS.cyan}>{line}</text>
    </box>
  );
}

function AgentCostRow(props: { readonly agent: AgentCostEntry; readonly isNarrow: boolean }): React.ReactNode {
  const { agent, isNarrow } = props;
  const nameWidth = isNarrow ? 16 : 20;
  const modelLabel = isNarrow ? abbreviateModel(agent.model).padEnd(3) : truncate(agent.model, 14);
  const bar = budgetBar(agent.budgetUsed, agent.budgetLimit, 10);
  const line =
    `  ${truncate(agent.name, nameWidth)}` +
    ` ${modelLabel}` +
    ` ${String(agent.turns).padStart(5)}` +
    `  ${formatUsd(agent.costUsd).padStart(8)}` +
    `  ${bar} ${formatUsd(agent.budgetUsed)} / ${formatUsd(agent.budgetLimit)}`;
  return (
    <box height={1}>
      <text fg={COLORS.cyan}>{line}</text>
    </box>
  );
}

function AgentCostTable(props: {
  readonly agents: readonly AgentCostEntry[];
  readonly scrollOffset: number;
  readonly isNarrow: boolean;
}): React.ReactNode {
  const VISIBLE_ROWS = 15;
  const visible = props.agents.slice(props.scrollOffset, props.scrollOffset + VISIBLE_ROWS);
  const header = props.isNarrow
    ? "  AGENT            MODEL     TURNS      COST    BUDGET"
    : "  AGENT                MODEL           TURNS      COST    BUDGET";
  return (
    <box flexDirection="column">
      <box height={1}>
        <text fg={COLORS.dim}>{header}</text>
      </box>
      {visible.map((agent) => (
        <AgentCostRow key={agent.agentId} agent={agent} isNarrow={props.isNarrow} />
      ))}
    </box>
  );
}

function CascadeTierRow(props: { readonly tier: CascadeTierSummary; readonly isNarrow: boolean }): React.ReactNode {
  const { tier, isNarrow } = props;
  const modelLabel = isNarrow ? abbreviateModel(tier.model).padEnd(3) : truncate(tier.model, 10);
  const line =
    `  ${modelLabel}` +
    ` ${String(tier.calls).padStart(4)} calls` +
    `  ${formatUsd(tier.costUsd).padStart(8)}` +
    `  ${String(Math.round(tier.percentOfCalls)).padStart(3)}% of calls (${tier.label})`;
  return (
    <box height={1}>
      <text fg={COLORS.cyan}>{line}</text>
    </box>
  );
}

function CascadeBreakdown(props: {
  readonly tiers: readonly CascadeTierSummary[];
  readonly savingsUsd: number;
  readonly baselineModel: string;
  readonly cols: number;
  readonly isNarrow: boolean;
}): React.ReactNode {
  return (
    <box flexDirection="column">
      <box height={1}>
        <text fg={COLORS.dim}>{separator(props.cols)}</text>
      </box>
      <box height={1}>
        <text fg={COLORS.white}>{"CASCADE BREAKDOWN"}</text>
      </box>
      {props.tiers.map((tier) => (
        <CascadeTierRow key={tier.model} tier={tier} isNarrow={props.isNarrow} />
      ))}
      <box height={1}>
        <text fg={COLORS.dim}>{`  ${separator(props.cols)}`}</text>
      </box>
      <box height={1}>
        <text fg={COLORS.dim}>
          {`  Cascade savings: ${formatUsd(props.savingsUsd)} (vs. all-${props.baselineModel} baseline)`}
        </text>
      </box>
    </box>
  );
}

function CircuitBreakerDisplay(props: {
  readonly cb: CircuitBreakerSummary;
}): React.ReactNode {
  const { cb } = props;
  const stateColor = circuitBreakerColor(cb.state);
  const windowSec = Math.round(cb.windowMs / 1000);
  return (
    <box flexDirection="column">
      <box height={1}>
        <text fg={COLORS.dim}>{"────────────────────────────────────────────"}</text>
      </box>
      <box height={1}>
        <text fg={stateColor}>
          {`CIRCUIT BREAKER  ${cb.state}  ${String(cb.failures)}/${String(cb.threshold)} failures (${String(windowSec)}s window)`}
        </text>
      </box>
    </box>
  );
}

export function CostView(props: CostViewProps): React.ReactNode {
  const { costView } = props;
  const { snapshot } = costView;
  const cols = props.cols ?? 120;
  const isNarrow = props.layoutTier === "narrow" || props.layoutTier === "tooNarrow";

  const isEmpty = snapshot === null;
  const agentCount = snapshot !== null ? snapshot.agents.length : 0;

  return (
    <PanelChrome
      title="Cost"
      count={agentCount}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={isEmpty}
      loading={costView.loading}
      loadingMessage="Fetching cost data…"
      emptyMessage="No cost data yet. Send a message to an agent to start tracking."
    >
      {snapshot !== null && (
        <box flexDirection="column">
          <BudgetHeader
            sessionUsed={snapshot.sessionBudget.used}
            sessionLimit={snapshot.sessionBudget.limit}
            dailyUsed={snapshot.dailyBudget.used}
            dailyLimit={snapshot.dailyBudget.limit}
            monthlyUsed={snapshot.monthlyBudget.used}
            monthlyLimit={snapshot.monthlyBudget.limit}
          />
          <box height={1} />
          <AgentCostTable agents={snapshot.agents} scrollOffset={costView.scrollOffset} isNarrow={isNarrow} />
          {snapshot.cascade.tiers.length > 0 && (
            <CascadeBreakdown
              tiers={snapshot.cascade.tiers}
              savingsUsd={snapshot.cascade.savingsUsd}
              baselineModel={snapshot.cascade.baselineModel}
              cols={cols}
              isNarrow={isNarrow}
            />
          )}
          <CircuitBreakerDisplay cb={snapshot.circuitBreaker} />
        </box>
      )}
    </PanelChrome>
  );
}
