/**
 * SSE hook — connects to the event stream and dispatches events to stores.
 *
 * Handles:
 * - Agent status_changed → update agent in Zustand store
 * - Agent dispatched → fetch full agent list (new agent added)
 * - Agent terminated → remove from store
 * - Connection state tracking via connection store
 *
 * Uses queueMicrotask to coalesce batch mutations into a single
 * React re-render (Decision 16A).
 */

import type { DashboardEvent, DashboardEventBatch } from "@koi/dashboard-types";
import { isAgentEvent } from "@koi/dashboard-types";
import { useEffect } from "react";
import { fetchAgents } from "../lib/api-client.js";
import { getDashboardConfig } from "../lib/dashboard-config.js";
import { createSseClient } from "../lib/sse-client.js";
import { useAgentsStore } from "../stores/agents-store.js";
import { useConnectionStore } from "../stores/connection-store.js";

function handleEvent(event: DashboardEvent): void {
  if (isAgentEvent(event)) {
    const store = useAgentsStore.getState();
    switch (event.subKind) {
      case "status_changed":
        store.updateAgent(event.agentId, {
          state: event.to,
          lastActivityAt: event.timestamp,
        });
        break;
      case "dispatched":
        // New agent — fetch full list to pick up the new entry
        void fetchAgents().then((agents) => {
          useAgentsStore.getState().setAgents(agents);
        });
        break;
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
}

export function useSse(): void {
  const setConnectionStatus = useConnectionStore((s) => s.setStatus);

  useEffect(() => {
    const { apiPath } = getDashboardConfig();
    const client = createSseClient({
      url: `${apiPath}/events`,
      onBatch: (batch: DashboardEventBatch) => {
        // Coalesce all mutations from this batch into one microtask
        // to avoid O(n) synchronous re-renders (Decision 16A)
        queueMicrotask(() => {
          for (const event of batch.events) {
            handleEvent(event);
          }
        });
      },
      onStateChange: setConnectionStatus,
      onReconnect: () => {
        // Rehydrate state via REST after reconnect to cover missed SSE events
        void fetchAgents().then((agents) => {
          useAgentsStore.getState().setAgents(agents);
        });
      },
    });

    return () => {
      client.close();
    };
  }, [setConnectionStatus]);
}
