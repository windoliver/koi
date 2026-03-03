/**
 * AsyncLocalStorage-based execution context for tool calls.
 *
 * Provides session identity (agent ID, session ID, user ID, channel) to tool
 * executions without modifying the L0 Tool interface. L1 wraps tool.execute()
 * with runWithExecutionContext(); tools read via getExecutionContext().
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionContext } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context available to tool executions within an L1 agent loop. */
export interface ToolExecutionContext {
  readonly session: SessionContext;
  readonly turnIndex: number;
}

// ---------------------------------------------------------------------------
// Well-known env var keys
// ---------------------------------------------------------------------------

/** Well-known KOI_* env var keys injected into child processes. */
export const CONTEXT_ENV_KEYS = {
  AGENT_ID: "KOI_AGENT_ID",
  SESSION_ID: "KOI_SESSION_ID",
  RUN_ID: "KOI_RUN_ID",
  USER_ID: "KOI_USER_ID",
  CHANNEL: "KOI_CHANNEL",
  TURN_INDEX: "KOI_TURN_INDEX",
} as const;

// ---------------------------------------------------------------------------
// AsyncLocalStorage store
// ---------------------------------------------------------------------------

const storage = new AsyncLocalStorage<ToolExecutionContext>();

/** Get the current tool execution context, or undefined if not in scope. */
export function getExecutionContext(): ToolExecutionContext | undefined {
  return storage.getStore();
}

/** Run a function within a tool execution context. */
export function runWithExecutionContext<T>(ctx: ToolExecutionContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

// ---------------------------------------------------------------------------
// Env var mapping
// ---------------------------------------------------------------------------

/** Build KOI_* env vars from a ToolExecutionContext. Omits undefined values. */
export function mapContextToEnv(ctx: ToolExecutionContext): Readonly<Record<string, string>> {
  const env: Record<string, string> = {
    [CONTEXT_ENV_KEYS.AGENT_ID]: ctx.session.agentId,
    [CONTEXT_ENV_KEYS.SESSION_ID]: ctx.session.sessionId,
    [CONTEXT_ENV_KEYS.RUN_ID]: ctx.session.runId,
    [CONTEXT_ENV_KEYS.TURN_INDEX]: String(ctx.turnIndex),
  };
  if (ctx.session.userId !== undefined) {
    env[CONTEXT_ENV_KEYS.USER_ID] = ctx.session.userId;
  }
  if (ctx.session.channelId !== undefined) {
    env[CONTEXT_ENV_KEYS.CHANNEL] = ctx.session.channelId;
  }
  return Object.freeze(env);
}
