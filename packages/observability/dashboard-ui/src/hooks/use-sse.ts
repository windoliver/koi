/**
 * SSE hook — connects to the event stream and dispatches events to stores.
 *
 * Routes events through domain-scoped dispatchers (Decision 8A)
 * instead of a monolithic switch statement.
 *
 * Uses queueMicrotask to coalesce batch mutations into a single
 * React re-render.
 */

import type { DashboardEventBatch } from "@koi/dashboard-types";
import { useEffect } from "react";
import { fetchAgents } from "../lib/api-client.js";
import { getDashboardConfig } from "../lib/dashboard-config.js";
import { createSseClient } from "../lib/sse-client.js";
import { useAgentsStore } from "../stores/agents-store.js";
import { useConnectionStore } from "../stores/connection-store.js";
import { dispatchDashboardEvent } from "./sse-dispatchers.js";

export function useSse(): void {
  const setConnectionStatus = useConnectionStore((s) => s.setStatus);

  useEffect(() => {
    const { apiPath } = getDashboardConfig();
    const client = createSseClient({
      url: `${apiPath}/events`,
      onBatch: (batch: DashboardEventBatch) => {
        // Coalesce all mutations from this batch into one microtask
        queueMicrotask(() => {
          for (const event of batch.events) {
            dispatchDashboardEvent(event);
          }
        });
      },
      onStateChange: setConnectionStatus,
      onReconnect: () => {
        // Rehydrate state via REST after reconnect to cover missed SSE events
        const reconnectedAt = Date.now();
        void fetchAgents().then((agents) => {
          useAgentsStore.getState().setAgents(agents, reconnectedAt);
        });
      },
    });

    return () => {
      client.close();
    };
  }, [setConnectionStatus]);
}
