/**
 * Domain-scoped SSE event dispatchers (Decision 8A).
 *
 * Each domain (agent, nexus, gateway, temporal, scheduler, taskboard, harness,
 * forge, monitor) owns its own dispatch function. A dispatch table routes
 * by event.kind (Decision 7A).
 */

import type { DashboardEvent } from "@koi/dashboard-types";
import {
  isAgentEvent,
  isForgeEvent,
  isGatewayEvent,
  isHarnessEvent,
  isMonitorEvent,
  isNexusEvent,
  isSchedulerEvent,
  isTaskBoardEvent,
  isTemporalEvent,
} from "@koi/dashboard-types";
import { fetchAgents } from "../lib/api-client.js";
import { useAgentsStore } from "../stores/agents-store.js";
import { useChatStore } from "../stores/chat-store.js";
import { useForgeStore } from "../stores/forge-store.js";
import { useOrchestrationStore } from "../stores/orchestration-store.js";
import { useTreeStore } from "../stores/tree-store.js";

/** Dispatch an agent domain event to the agents store (and chat store for lifecycle). */
function dispatchAgentEvent(event: DashboardEvent): void {
  if (!isAgentEvent(event)) return;
  const store = useAgentsStore.getState();
  const chatStore = useChatStore.getState();
  const chatSession = chatStore.session;
  switch (event.subKind) {
    case "status_changed":
      store.updateAgent(event.agentId, {
        state: event.to,
        lastActivityAt: event.timestamp,
      });
      // Surface status change in the active chat session
      if (chatSession?.agentId === event.agentId) {
        chatStore.addMessage({
          kind: "lifecycle",
          event: `Agent status: ${event.from} \u2192 ${event.to}`,
          timestamp: event.timestamp,
        });
      }
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
      // Notify active chat session that the agent was terminated
      if (chatSession?.agentId === event.agentId) {
        chatStore.addMessage({
          kind: "lifecycle",
          event: "Agent terminated",
          timestamp: event.timestamp,
        });
        chatStore.setStreaming(false);
        chatStore.setAgentTerminated(true);
      }
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

/** Orchestration invalidation debounce timer (200ms coalescing). */
let orchestrationInvalidateTimer: ReturnType<typeof setTimeout> | undefined;

function invalidateOrchestrationDebounced(): void {
  if (orchestrationInvalidateTimer !== undefined) {
    clearTimeout(orchestrationInvalidateTimer);
  }
  orchestrationInvalidateTimer = setTimeout(() => {
    useOrchestrationStore.getState().invalidate();
    orchestrationInvalidateTimer = undefined;
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

/** Dispatch a temporal event — debounced orchestration invalidation. */
function dispatchTemporalEvent(event: DashboardEvent): void {
  if (!isTemporalEvent(event)) return;
  invalidateOrchestrationDebounced();
}

/** Dispatch a scheduler event — debounced orchestration invalidation. */
function dispatchSchedulerEvent(event: DashboardEvent): void {
  if (!isSchedulerEvent(event)) return;
  invalidateOrchestrationDebounced();
}

/** Dispatch a task board event — debounced orchestration invalidation. */
function dispatchTaskBoardEvent(event: DashboardEvent): void {
  if (!isTaskBoardEvent(event)) return;
  invalidateOrchestrationDebounced();
}

/** Dispatch a harness event — debounced orchestration invalidation. */
function dispatchHarnessEvent(event: DashboardEvent): void {
  if (!isHarnessEvent(event)) return;
  invalidateOrchestrationDebounced();
}

/** Dispatch a forge event — batched via ForgeStore.applyBatch. */
function dispatchForgeEvent(event: DashboardEvent): void {
  if (!isForgeEvent(event)) return;
  useForgeStore.getState().applyBatch([event]);
}

/** Dispatch a monitor event to the forge store for TUI co-display. */
function dispatchMonitorEvent(event: DashboardEvent): void {
  if (!isMonitorEvent(event)) return;
  useForgeStore.getState().applyMonitorEvent(event);
}

// ---------------------------------------------------------------------------
// Dispatch table (Decision 7A)
// ---------------------------------------------------------------------------

const DISPATCHERS: Partial<Record<DashboardEvent["kind"], (e: DashboardEvent) => void>> = {
  agent: dispatchAgentEvent,
  nexus: dispatchNexusEvent,
  gateway: dispatchGatewayEvent,
  temporal: dispatchTemporalEvent,
  scheduler: dispatchSchedulerEvent,
  taskboard: dispatchTaskBoardEvent,
  harness: dispatchHarnessEvent,
  forge: dispatchForgeEvent,
  monitor: dispatchMonitorEvent,
};

/**
 * Route a dashboard event to the appropriate domain dispatcher.
 * Called from the SSE hook for each event in a batch.
 */
export function dispatchDashboardEvent(event: DashboardEvent): void {
  DISPATCHERS[event.kind]?.(event);
}
