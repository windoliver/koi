/**
 * createChatRouter — routes AG-UI chat requests by agentId.
 *
 * Routes to the primary agent's chat handler by default, falling
 * through to dispatched agents when a matching handler is found.
 */

import type { AgentChatHandler } from "@koi/dashboard-api";

export interface ChatRouterOptions {
  /** Chat handler for the primary (host) agent. */
  readonly primaryHandler: AgentChatHandler;
  /** Lookup chat handler for a dispatched agent by ID. */
  readonly getDispatchedHandler: (
    agentId: string,
  ) => ((req: Request) => Promise<Response>) | undefined;
}

/**
 * Creates a routing AgentChatHandler that dispatches to the correct
 * handler based on agentId. Dispatched agents take priority — if no
 * dispatched handler is found, falls through to the primary handler.
 */
export function createChatRouter(opts: ChatRouterOptions): AgentChatHandler {
  return async (req: Request, agentId: string): Promise<Response> => {
    const dispatched = opts.getDispatchedHandler(agentId);
    if (dispatched !== undefined) return dispatched(req);
    return opts.primaryHandler(req, agentId);
  };
}
