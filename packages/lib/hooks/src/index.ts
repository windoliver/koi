/**
 * @koi/hooks — Hook loader, schema validation, session-scoped lifecycle,
 * and middleware dispatch (Layer 2)
 *
 * Depends on @koi/core (L0) for hook types and @koi/validation (L0u) for Zod helpers.
 */

export type { CreateAgentExecutorOptions } from "./agent-executor.js";
export { AgentHookExecutor, createAgentExecutor, mergeToolDenylist } from "./agent-executor.js";
export type { HookVerdictResult } from "./agent-verdict.js";
export {
  DEFAULT_AGENT_SYSTEM_PROMPT,
  HOOK_VERDICT_INPUT_SCHEMA,
  HOOK_VERDICT_TOOL_NAME,
  parseVerdictOutput,
  verdictToDecision,
} from "./agent-verdict.js";
export type { EnvExpandResult, EnvRecordExpandResult } from "./env.js";
export { buildEnvAllowSet, expandEnvVars, expandEnvVarsInRecord, matchEnvGlob } from "./env.js";
export { executeHooks } from "./executor.js";
export { matchesHookFilter } from "./filter.js";
export type { HookExecutor } from "./hook-executor.js";
export { resolveFailMode, resolveTimeout, validateHookUrl } from "./hook-validation.js";
export type { LoadHooksResult } from "./loader.js";
export { loadHooks, loadHooksWithDiagnostics } from "./loader.js";
export type { AggregatedDecision, CreateHookMiddlewareOptions } from "./middleware.js";
export { aggregateDecisions, aggregatePostDecisions, createHookMiddleware } from "./middleware.js";
export type { PayloadStatus, RedactedPayload } from "./payload-redaction.js";
export { extractStructure, redactEventData } from "./payload-redaction.js";
export type { CreatePromptAdapterOptions } from "./prompt-adapter.js";
export { PromptExecutorAdapter } from "./prompt-adapter.js";
export type { CreateHookRegistryOptions, HookRegistry } from "./registry.js";
export { createHookRegistry } from "./registry.js";
export {
  agentHookSchema,
  commandHookSchema,
  hookConfigSchema,
  hookFilterSchema,
  httpHookSchema,
  promptHookSchema,
} from "./schema.js";
