/**
 * @koi/execution-context — Execution context utilities for Koi middleware and adapters.
 *
 * Includes:
 * - AsyncLocalStorage-based session context for tool executions
 * - Typed side-channels for middleware → engine adapter communication
 */

export { type CacheHints, PROMPT_CACHE_HINTS } from "./cache-hints.js";
export {
  CONTEXT_ENV_KEYS,
  getExecutionContext,
  mapContextToEnv,
  runWithExecutionContext,
  type ToolExecutionContext,
} from "./execution-context.js";
export { createSideChannel, type SideChannel } from "./side-channel.js";
