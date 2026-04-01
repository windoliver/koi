/**
 * @koi/hooks — Hook loader, schema validation, and session-scoped lifecycle (Layer 2)
 *
 * Depends on @koi/core (L0) for hook types and @koi/validation (L0u) for Zod helpers.
 */

export { expandEnvVars, expandEnvVarsInRecord } from "./env.js";
export { executeHooks } from "./executor.js";
export { matchesHookFilter } from "./filter.js";
export type { LoadHooksResult } from "./loader.js";
export { loadHooks } from "./loader.js";
export type { HookRegistry } from "./registry.js";
export { createHookRegistry } from "./registry.js";
export { commandHookSchema, hookConfigSchema, hookFilterSchema, httpHookSchema } from "./schema.js";
