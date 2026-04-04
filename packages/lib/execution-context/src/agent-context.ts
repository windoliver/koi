/**
 * AsyncLocalStorage-based agent execution context.
 *
 * Provides agent identity (agent ID, session ID, parent) to spawned agent
 * executions without modifying the L0 interfaces. L1 wraps spawned agent
 * runs with runWithAgentContext(); consumers read via getAgentContext().
 *
 * This is the outer scope — tool execution context nests inside it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context available to spawned agent executions for identity isolation. */
export interface AgentExecutionContext {
  readonly agentId: string;
  readonly sessionId: string;
  readonly parentAgentId?: string | undefined;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage store
// ---------------------------------------------------------------------------

const storage = new AsyncLocalStorage<AgentExecutionContext>();

/** Get the current agent execution context, or undefined if not in scope. */
export function getAgentContext(): AgentExecutionContext | undefined {
  return storage.getStore();
}

/** Run a function within an agent execution context. */
export function runWithAgentContext<T>(ctx: AgentExecutionContext, fn: () => T): T {
  return storage.run(ctx, fn);
}
