/**
 * SSE hook — connects to the event stream and dispatches events to stores.
 *
 * Routes events through domain-scoped dispatchers (Decision 8A)
 * instead of a monolithic switch statement.
 *
 * Forge events are batched per-batch for efficient store updates (Decision 14A).
 * Uses queueMicrotask to coalesce batch mutations into a single React re-render.
 */

import type { DashboardEventBatch, ForgeDashboardEvent } from "@koi/dashboard-types";
import { isForgeEvent } from "@koi/dashboard-types";
import { useEffect } from "react";
import { fetchAgents, fetchForgeBricks } from "../lib/api-client.js";
import { getDashboardConfig } from "../lib/dashboard-config.js";
import { createSseClient } from "../lib/sse-client.js";
import { useAgentsStore } from "../stores/agents-store.js";
import { useConnectionStore } from "../stores/connection-store.js";
import { useForgeStore } from "../stores/forge-store.js";
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
          const forgeEvents: ForgeDashboardEvent[] = [];
          for (const event of batch.events) {
            if (isForgeEvent(event)) {
              forgeEvents.push(event);
            } else {
              dispatchDashboardEvent(event);
            }
          }
          if (forgeEvents.length > 0) {
            useForgeStore.getState().applyBatch(forgeEvents);
          }
        });
      },
      onStateChange: setConnectionStatus,
      onReconnect: () => {
        // Clear stale forge buffer on reconnect
        useForgeStore.getState().resetBuffer();
        // Rehydrate state via REST after reconnect to cover missed SSE events
        const reconnectedAt = Date.now();
        void fetchAgents().then((agents) => {
          useAgentsStore.getState().setAgents(agents, reconnectedAt);
        });
        // Rehydrate forge brick state via REST (preserves status + fitness)
        void fetchForgeBricks()
          .then((bricks) => {
            useForgeStore.getState().hydrateBricks(bricks);
          })
          .catch(() => {
            // Forge rehydration is non-fatal — page works with SSE-only data
          });
      },
    });

    return () => {
      client.close();
    };
  }, [setConnectionStatus]);
}
