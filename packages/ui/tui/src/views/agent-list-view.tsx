/**
 * Agent list view — displays running agents in a selectable list.
 *
 * Uses OpenTUI's <select> component for keyboard-navigable agent selection.
 * Shows agent name, state, model, and turn count.
 */

import type { DashboardAgentSummary } from "@koi/dashboard-types";
import type { SelectOption } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { type Accessor, Show } from "solid-js";
import { COLORS } from "../theme.js";

/** Props for the agent list view. */
export interface AgentListViewProps {
  readonly agents: Accessor<readonly DashboardAgentSummary[]>;
  readonly onSelect: (agentId: string) => void;
  readonly focused: boolean;
}

/** Format an agent summary as a select option description. */
function formatAgentDescription(agent: DashboardAgentSummary): string {
  const elapsed = Math.round((Date.now() - agent.startedAt) / 1000);
  const timeLabel = elapsed < 60 ? `${String(elapsed)}s` : `${String(Math.round(elapsed / 60))}m`;
  return `${agent.state} │ ${agent.model} │ ${String(agent.turns)} turns │ ${timeLabel}`;
}

/** Map agent summaries to SelectOption array. */
function agentsToOptions(agents: readonly DashboardAgentSummary[]): readonly SelectOption[] {
  return agents.map((a) => ({
    name: a.name,
    description: formatAgentDescription(a),
    value: a.agentId,
  }));
}

/** Agent list view with selectable agent entries. */
export function AgentListView(props: AgentListViewProps): JSX.Element {
  const options = () => agentsToOptions(props.agents());

  return (
    <box flexGrow={1} flexDirection="column">
      <box height={1} flexDirection="row">
        <text fg={COLORS.cyan}><b>{" Agents"}</b></text>
        <text fg={COLORS.dim}>{` (${String(props.agents().length)})`}</text>
      </box>

      <Show
        when={props.agents().length > 0}
        fallback={
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg={COLORS.dim}>{"No agents found. Press Ctrl+R to refresh."}</text>
          </box>
        }
      >
        <select
          options={options() as SelectOption[]}
          focused={props.focused}
          showDescription={true}
          wrapSelection={true}
          selectedBackgroundColor={COLORS.blue}
          selectedTextColor={COLORS.white}
          descriptionColor={COLORS.dim}
          onSelect={(index: number, option: SelectOption | null) => {
            if (option?.value !== undefined) {
              props.onSelect(option.value as string);
            }
          }}
        />
      </Show>
    </box>
  );
}
