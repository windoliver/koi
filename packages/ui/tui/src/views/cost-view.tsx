import { PanelChrome } from "../components/panel-chrome.js";
import type { CostViewState } from "../state/domain-types.js";
import type { DashboardAgentSummary } from "@koi/dashboard-types";
import { COLORS } from "../theme.js";

export interface CostViewProps {
  readonly costView: CostViewState;
  readonly agents: readonly DashboardAgentSummary[];
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function CostView(props: CostViewProps): React.ReactNode {
  const { agents, costView } = props;
  const VISIBLE_ROWS = 20;
  const visible = agents.slice(costView.scrollOffset, costView.scrollOffset + VISIBLE_ROWS);

  // Compute totals
  let totalTurns = 0;
  for (const agent of agents) {
    totalTurns += agent.turns;
  }

  return (
    <PanelChrome
      title="Cost"
      count={agents.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={agents.length === 0}
      emptyMessage="No agents to show cost for."
    >
      <box height={1}>
        <text fg={COLORS.dim}>
          {` Total agents: ${String(agents.length)} │ Total turns: ${String(totalTurns)}`}
        </text>
      </box>
      <box flexDirection="column">
        <box height={1}>
          <text fg={COLORS.dim}>{" Agent                State        Turns    Type"}</text>
        </box>
        {visible.map((agent) => (
          <box key={agent.agentId} height={1}>
            <text>
              {` ${agent.name.padEnd(20).slice(0, 20)} ${agent.state.padEnd(12)} ${String(agent.turns).padStart(5)}    ${agent.agentType}`}
            </text>
          </box>
        ))}
      </box>
    </PanelChrome>
  );
}
