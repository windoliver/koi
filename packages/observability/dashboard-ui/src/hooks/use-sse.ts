/**
 * SSE hook — connects to the event stream and dispatches events to stores.
 *
 * Handles:
 * - Agent status_changed → update agent in Zustand store
 * - Agent dispatched → invalidate agents query for full refresh
 * - Agent terminated → remove from store + invalidate
 * - Connection state tracking via connection store
 */

import type { DashboardEvent, DashboardEventBatch } from "@koi/dashboard-types";
import { isAgentEvent } from "@koi/dashboard-types";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { getDashboardConfig } from "../lib/dashboard-config.js";
import { createSseClient } from "../lib/sse-client.js";
import { useAgentsStore } from "../stores/agents-store.js";
import { useConnectionStore } from "../stores/connection-store.js";
import { AGENTS_QUERY_KEY } from "./use-agents.js";

function handleEvent(event: DashboardEvent, queryClient: QueryClient): void {
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
        // New agent — trigger full refresh
        void queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
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

export function useSse(queryClient: QueryClient): void {
  const setConnectionStatus = useConnectionStore((s) => s.setStatus);

  useEffect(() => {
    const { apiPath } = getDashboardConfig();
    const client = createSseClient({
      url: `${apiPath}/events`,
      onBatch: (batch: DashboardEventBatch) => {
        for (const event of batch.events) {
          handleEvent(event, queryClient);
        }
      },
      onStateChange: setConnectionStatus,
    });

    return () => {
      client.close();
    };
  }, [queryClient, setConnectionStatus]);
}
