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

export interface AgentChatBridgeOptions {
  /**
   * AG-UI normalization mode.
   *
   * - `"stateful"` — only the last user message is forwarded; the runtime
   *   stack (e.g. conversation middleware / context-arena) already maintains
   *   per-thread history.
   * - `"stateless"` — all prior messages sent by the browser are flattened
   *   into the inbound text so the engine receives full conversation context
   *   even without dedicated conversation middleware.
   *
   * Default: `"stateless"` (safe for runtimes without conversation middleware).
   */
  readonly mode?: "stateful" | "stateless";
}

export function createAgentChatBridge(options?: AgentChatBridgeOptions): AgentChatBridge {
  const mode = options?.mode ?? "stateless";
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
    return handleAguiRequest(req, store, mode, dispatchFn);
  };

  return {
    middleware,
    handler,
    wireDispatch: (fn) => {
      dispatchFn = fn;
    },
  };
}
