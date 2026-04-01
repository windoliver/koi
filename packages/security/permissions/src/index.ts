/**
 * @koi/permissions — rule-based tool access control.
 *
 * Implements the L0 PermissionBackend contract with glob-based rules,
 * multi-source config precedence, and permission modes.
 */

export { createPermissionBackend } from "./create-permission-backend.js";
export { resolveMode } from "./mode-resolver.js";
export { compileGlob, evaluateRules } from "./rule-evaluator.js";
export { loadRules } from "./rule-loader.js";
export type {
  CompiledRule,
  PermissionConfig,
  PermissionMode,
  PermissionRule,
  RuleEffect,
  RuleSource,
  SourcedRule,
} from "./rule-types.js";
export { PLAN_ALLOWED_ACTIONS, SOURCE_PRECEDENCE } from "./rule-types.js";
