/**
 * AG-UI chat bridge — creates an AG-UI handler for the dashboard chat endpoint.
 *
 * Produces a KoiMiddleware (for the runtime stack) and an AgentChatHandler
 * (for the dashboard). The dispatch function is wired after runtime creation
 * via wireDispatch().
 *
 * Used by `koi serve --admin` to make POST /agents/:id/chat functional.
 */

import {
  createAguiStreamMiddleware,
  createRunContextStore,
  handleAguiRequest,
} from "@koi/channel-agui";
import type { InboundMessage, KoiMiddleware } from "@koi/core";
import type { AgentChatHandler } from "@koi/dashboard-api";

export interface AgentChatBridge {
  /** Include in the runtime middleware stack for real-time SSE streaming. */
  readonly middleware: KoiMiddleware;
  /** Pass to createDashboardHandler as agentChatHandler. */
  readonly handler: AgentChatHandler;
  /** Wire the dispatch function after runtime creation. */
  readonly wireDispatch: (fn: (msg: InboundMessage) => Promise<void>) => void;
}

export function createAgentChatBridge(): AgentChatBridge {
  const store = createRunContextStore();
  const middleware = createAguiStreamMiddleware({ store });

  // let justified: set after runtime creation via wireDispatch()
  let dispatchFn: ((msg: InboundMessage) => Promise<void>) | undefined;

  const handler: AgentChatHandler = async (req: Request, _agentId: string): Promise<Response> => {
    if (dispatchFn === undefined) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "NOT_READY", message: "Agent not ready" },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    return handleAguiRequest(req, store, "stateless", dispatchFn);
  };

  return {
    middleware,
    handler,
    wireDispatch: (fn) => {
      dispatchFn = fn;
    },
  };
}
