/**
 * @koi/execution-context — Execution context utilities for Koi middleware and adapters.
 *
 * Includes:
 * - AsyncLocalStorage-based agent context for identity isolation
 * - AsyncLocalStorage-based session context for tool executions
 * - Typed side-channels for middleware → engine adapter communication
 */

export {
  type AgentExecutionContext,
  getAgentContext,
  runWithAgentContext,
} from "./agent-context.js";
export { type CacheHints, PROMPT_CACHE_HINTS } from "./cache-hints.js";
export {
  CONTEXT_ENV_KEYS,
  getExecutionContext,
  mapContextToEnv,
  runWithExecutionContext,
  type ToolExecutionContext,
} from "./execution-context.js";
export { createSideChannel, type SideChannel } from "./side-channel.js";
export {
  type ChildSpanRecord,
  getSpanRecorder,
  runWithSpanRecorder,
  type SpanRecorder,
} from "./span-context.js";
