/**
 * Domain-scoped SSE event dispatchers (Decision 8A).
 *
 * Each domain (agent, nexus, gateway, temporal, scheduler, taskboard, harness)
 * owns its own dispatch function. The SSE hook routes by event.kind and delegates.
 */

import type { DashboardEvent } from "@koi/dashboard-types";
import {
  isAgentEvent,
  isGatewayEvent,
  isHarnessEvent,
  isNexusEvent,
  isSchedulerEvent,
  isTaskBoardEvent,
  isTemporalEvent,
} from "@koi/dashboard-types";
import { fetchAgents } from "../lib/api-client.js";
import { useAgentsStore } from "../stores/agents-store.js";
import { useTreeStore } from "../stores/tree-store.js";

/** Dispatch an agent domain event to the agents store. */
function dispatchAgentEvent(event: DashboardEvent): void {
  if (!isAgentEvent(event)) return;
  const store = useAgentsStore.getState();
  switch (event.subKind) {
    case "status_changed":
      store.updateAgent(event.agentId, {
        state: event.to,
        lastActivityAt: event.timestamp,
      });
      break;
    case "dispatched": {
      const dispatchedAt = Date.now();
      void fetchAgents().then((agents) => {
        useAgentsStore.getState().setAgents(agents, dispatchedAt);
      });
      break;
    }
    case "terminated":
      store.removeAgent(event.agentId);
      break;
    case "metrics_updated":
      store.updateAgent(event.agentId, {
        turns: event.turns,
        lastActivityAt: event.timestamp,
      });
      break;
  }
}

/** Tree invalidation debounce timer (Decision 15A — 200ms coalescing). */
let treeInvalidateTimer: ReturnType<typeof setTimeout> | undefined;

function invalidateTreeDebounced(): void {
  if (treeInvalidateTimer !== undefined) {
    clearTimeout(treeInvalidateTimer);
  }
  treeInvalidateTimer = setTimeout(() => {
    useTreeStore.getState().invalidateTree();
    treeInvalidateTimer = undefined;
  }, 200);
}

/** Dispatch a nexus event — debounced tree invalidation. */
function dispatchNexusEvent(event: DashboardEvent): void {
  if (!isNexusEvent(event)) return;
  invalidateTreeDebounced();
}

/** Dispatch a gateway event — debounced tree invalidation. */
function dispatchGatewayEvent(event: DashboardEvent): void {
  if (!isGatewayEvent(event)) return;
  invalidateTreeDebounced();
}

/** Dispatch a temporal event — currently a no-op (store refreshed via REST). */
function dispatchTemporalEvent(event: DashboardEvent): void {
  if (!isTemporalEvent(event)) return;
  // Temporal events invalidate the orchestration tab to trigger REST refetch.
  // Direct store mutation will be added when the SSE→store bridge is wired.
}

/** Dispatch a scheduler event — currently a no-op (store refreshed via REST). */
function dispatchSchedulerEvent(event: DashboardEvent): void {
  if (!isSchedulerEvent(event)) return;
}

/** Dispatch a task board event — currently a no-op (store refreshed via REST). */
function dispatchTaskBoardEvent(event: DashboardEvent): void {
  if (!isTaskBoardEvent(event)) return;
}

/** Dispatch a harness event — currently a no-op (store refreshed via REST). */
function dispatchHarnessEvent(event: DashboardEvent): void {
  if (!isHarnessEvent(event)) return;
}

/**
 * Route a dashboard event to the appropriate domain dispatcher.
 * Called from the SSE hook for each event in a batch.
 */
export function dispatchDashboardEvent(event: DashboardEvent): void {
  switch (event.kind) {
    case "agent":
      dispatchAgentEvent(event);
      break;
    case "nexus":
      dispatchNexusEvent(event);
      break;
    case "gateway":
      dispatchGatewayEvent(event);
      break;
    case "temporal":
      dispatchTemporalEvent(event);
      break;
    case "scheduler":
      dispatchSchedulerEvent(event);
      break;
    case "taskboard":
      dispatchTaskBoardEvent(event);
      break;
    case "harness":
      dispatchHarnessEvent(event);
      break;
    // skill, channel, system — no store dispatch needed currently
    default:
      break;
  }
}
