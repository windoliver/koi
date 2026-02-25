/**
 * @koi/execution-context — AsyncLocalStorage-based session context for tool executions.
 *
 * L1 sets the context around tool.execute(); tools and child processes read it
 * via getExecutionContext() or KOI_* environment variables.
 */

export {
  CONTEXT_ENV_KEYS,
  getExecutionContext,
  mapContextToEnv,
  runWithExecutionContext,
  type ToolExecutionContext,
} from "./execution-context.js";
