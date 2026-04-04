/**
 * @koi/permissions — rule-based tool access control.
 *
 * Implements the L0 PermissionBackend contract with glob-based rules,
 * multi-source config precedence, and permission modes.
 */

export { createPermissionBackend } from "./create-permission-backend.js";
export {
  CREDENTIAL_DENY_RULES,
  createCredentialDenyRules,
} from "./credential-deny-rules.js";
export type { PlanModeOptions } from "./mode-resolver.js";
export { resolveMode } from "./mode-resolver.js";
export { compileGlob, evaluateRules, normalizeResource } from "./rule-evaluator.js";
export { loadRules } from "./rule-loader.js";
export type {
  PermissionConfig,
  PermissionMode,
  PermissionRule,
  RuleEffect,
  RuleSource,
  SourcedRule,
} from "./rule-types.js";
export {
  PLAN_ALLOWED_ACTIONS,
  PLAN_RULE_EVALUATED_ACTIONS,
  PLAN_SAFE_VOCABULARY,
  SOURCE_PRECEDENCE,
} from "./rule-types.js";
