/**
 * @koi/hooks — Hook loader, schema validation, session-scoped lifecycle,
 * and middleware dispatch (Layer 2)
 *
 * Depends on @koi/core (L0) for hook types and @koi/validation (L0u) for Zod helpers.
 */

export type { EnvExpandResult, EnvRecordExpandResult } from "./env.js";
export { buildEnvAllowSet, expandEnvVars, expandEnvVarsInRecord, matchEnvGlob } from "./env.js";
export { executeHooks } from "./executor.js";
export { matchesHookFilter } from "./filter.js";
export type { LoadHooksResult } from "./loader.js";
export { loadHooks, loadHooksWithDiagnostics } from "./loader.js";
export type { CreateHookMiddlewareOptions } from "./middleware.js";
export { aggregateDecisions, aggregatePostDecisions, createHookMiddleware } from "./middleware.js";
export type { HookRegistry } from "./registry.js";
export { createHookRegistry } from "./registry.js";
export { commandHookSchema, hookConfigSchema, hookFilterSchema, httpHookSchema } from "./schema.js";
