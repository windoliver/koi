/**
 * Agent list view — browsable list of running agents.
 *
 * Uses pi-tui SelectList with Koi theming. Maps DashboardAgentSummary
 * items to SelectItem shape for rendering.
 */

import type { DashboardAgentSummary } from "@koi/dashboard-types";
import { type SelectItem, SelectList } from "@mariozechner/pi-tui";
import { KOI_SELECT_THEME, styleAgentState } from "../theme.js";

/** Maximum visible items before scrolling. */
const MAX_VISIBLE = 15;

/** Convert a DashboardAgentSummary to a pi-tui SelectItem. */
function agentToItem(agent: DashboardAgentSummary): SelectItem {
  const stateLabel = styleAgentState(agent.state);
  const typeLabel = agent.agentType === "copilot" ? "copilot" : "worker";
  const elapsed = formatElapsed(Date.now() - agent.startedAt);

  return {
    value: agent.agentId,
    label: `${agent.name} (${typeLabel})`,
    description: `${stateLabel}  turns: ${String(agent.turns)}  up: ${elapsed}`,
  };
}

/** Format milliseconds as human-readable elapsed time. */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${String(hours)}h${String(remainingMinutes)}m`;
}

/** Callbacks for agent list interactions. */
export interface AgentListCallbacks {
  readonly onSelect: (agentId: string) => void;
  readonly onCancel: () => void;
}

/** Create an agent list view component. */
export function createAgentListView(callbacks: AgentListCallbacks): {
  readonly component: SelectList;
  readonly update: (agents: readonly DashboardAgentSummary[]) => void;
} {
  const emptyItems: readonly SelectItem[] = [
    {
      value: "__empty__",
      label: "No agents running",
      description: "Waiting for agents to connect…",
    },
  ];

  const list = new SelectList([...emptyItems], MAX_VISIBLE, KOI_SELECT_THEME);

  list.onSelect = (item: SelectItem) => {
    if (item.value !== "__empty__") {
      callbacks.onSelect(item.value);
    }
  };

  list.onCancel = () => {
    callbacks.onCancel();
  };

  function update(agents: readonly DashboardAgentSummary[]): void {
    const items = agents.length > 0 ? agents.map(agentToItem) : [...emptyItems];

    // SelectList doesn't have a setItems method — we need to recreate
    // For now, use the filter trick: set filter empty to reset
    // Actually pi-tui SelectList takes items at construction only.
    // We'll work around by directly mutating the internal items.
    // This is the one place we accept mutation (pi-tui API limitation).
    const listAny = list as unknown as { items: SelectItem[] };
    listAny.items = items;
    list.setFilter("");
    list.setSelectedIndex(0);
    list.invalidate();
  }

  return { component: list, update };
}
