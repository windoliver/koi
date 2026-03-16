/**
 * Agent list view — displays running agents in a selectable list.
 *
 * Uses OpenTUI's <select> component for keyboard-navigable agent selection.
 * Shows agent name, state, model, and turn count.
 */

import type { DashboardAgentSummary } from "@koi/dashboard-types";
import type { SelectOption } from "@opentui/core";
import { useMemo } from "react";
import { PanelChrome } from "../components/panel-chrome.js";
import { COLORS } from "../theme.js";

/** Props for the agent list view. */
export interface AgentListViewProps {
  readonly agents: readonly DashboardAgentSummary[];
  readonly onSelect: (agentId: string) => void;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
  readonly listMode?: "flat" | "tree" | undefined;
}

/** Format an agent summary as a select option description. */
function formatAgentDescription(agent: DashboardAgentSummary): string {
  const elapsed = Math.round((Date.now() - agent.startedAt) / 1000);
  const timeLabel = elapsed < 60 ? `${String(elapsed)}s` : `${String(Math.round(elapsed / 60))}m`;
  return `${agent.state} │ ${agent.model} │ ${String(agent.turns)} turns │ ${timeLabel}`;
}

/** Map agent summaries to SelectOption array (flat mode). */
function agentsToOptions(agents: readonly DashboardAgentSummary[]): readonly SelectOption[] {
  return agents.map((a) => ({
    name: a.name,
    description: formatAgentDescription(a),
    value: a.agentId,
  }));
}

/** Map agent summaries to SelectOption array with tree grouping by type. */
function agentsToTreeOptions(agents: readonly DashboardAgentSummary[]): readonly SelectOption[] {
  const copilots = agents.filter((a) => a.agentType === "copilot");
  const workers = agents.filter((a) => a.agentType === "worker");
  const result: SelectOption[] = [];
  if (copilots.length > 0) {
    result.push({ name: "── copilots ──", description: "", value: "__header_copilot__" });
    for (const a of copilots) {
      result.push({ name: `  ${a.name}`, description: formatAgentDescription(a), value: a.agentId });
    }
  }
  if (workers.length > 0) {
    result.push({ name: "── workers ──", description: "", value: "__header_worker__" });
    for (const a of workers) {
      result.push({ name: `  ${a.name}`, description: formatAgentDescription(a), value: a.agentId });
    }
  }
  return result;
}

/** Agent list view with selectable agent entries. */
export function AgentListView(props: AgentListViewProps): React.ReactNode {
  const isTree = props.listMode === "tree";
  const options = useMemo(
    () => (isTree ? agentsToTreeOptions(props.agents) : agentsToOptions(props.agents)),
    [props.agents, isTree],
  );

  return (
    <PanelChrome
      title="Agents"
      count={props.agents.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={props.agents.length === 0}
      emptyMessage="No agents running."
      emptyHint="Press Ctrl+P → /dispatch to spawn one, or run koi up --preset demo."
    >
      <select
        options={options as SelectOption[]}
        focused={props.focused}
        showDescription={true}
        wrapSelection={true}
        flexGrow={1}
        selectedBackgroundColor={COLORS.blue}
        selectedTextColor={COLORS.white}
        descriptionColor={COLORS.dim}
        onSelect={(index: number, option: SelectOption | null) => {
          if (option?.value !== undefined) {
            props.onSelect(option.value as string);
          }
        }}
      />
    </PanelChrome>
  );
}
