/**
 * Permission rule types — shared across evaluator, loader, and mode resolver.
 */

/** Effect a rule applies when matched. */
export type RuleEffect = "allow" | "deny" | "ask";

/** A single permission rule matching resource patterns to effects. */
export interface PermissionRule {
  /** Glob pattern matched against `PermissionQuery.resource`. */
  readonly pattern: string;
  /** Action name to match, or `"*"` for all actions. */
  readonly action: string;
  /** What happens when the rule matches. */
  readonly effect: RuleEffect;
  /** Glob pattern matched against `PermissionQuery.principal`. Omit or `"*"` to match all. */
  readonly principal?: string | undefined;
  /**
   * Context predicates — each key must exist in `PermissionQuery.context`
   * and its value must match the glob pattern. Omit to match regardless of context.
   * Example: `{ zoneId: "us-east-*" }` matches queries with `context.zoneId` starting with "us-east-".
   */
  readonly context?: Readonly<Record<string, string>> | undefined;
  /** Human-readable reason surfaced in deny/ask decisions. */
  readonly reason?: string | undefined;
}

/**
 * Where a rule was loaded from. Determines precedence:
 * policy > project > local > user (policy = highest priority).
 */
export type RuleSource = "policy" | "project" | "local" | "user";

/** A rule tagged with its origin source for precedence sorting. */
export interface SourcedRule extends PermissionRule {
  readonly source: RuleSource;
}

/** A sourced rule with its glob patterns pre-compiled to RegExp. */
export interface CompiledRule extends SourcedRule {
  /** Compiled resource pattern. */
  readonly compiled: RegExp;
  /** Compiled principal pattern. Undefined means match all principals. */
  readonly compiledPrincipal?: RegExp | undefined;
  /** Compiled context predicates. Undefined means match regardless of context. */
  readonly compiledContext?: Readonly<Record<string, RegExp>> | undefined;
}

/**
 * Permission mode controls the overall decision strategy:
 * - `"default"` — evaluate rules; fall back to ask
 * - `"bypass"`  — always allow (CI / trusted automation)
 * - `"plan"`    — deny write actions; allow reads
 * - `"auto"`    — evaluate rules; fall back to ask (classifier in #1236 may promote to allow)
 */
export type PermissionMode = "default" | "bypass" | "plan" | "auto";

/** Top-level configuration for createPermissionBackend. */
export interface PermissionConfig {
  readonly mode: PermissionMode;
  readonly rules: readonly CompiledRule[];
  /**
   * Override the default set of actions auto-allowed in plan mode.
   * When omitted, uses `PLAN_ALLOWED_ACTIONS`.
   */
  readonly planAllowedActions?: readonly string[] | undefined;
  /**
   * Override the default set of actions that are rule-evaluated (not auto-allowed,
   * not hard-denied) in plan mode. When omitted, uses `PLAN_RULE_EVALUATED_ACTIONS`.
   */
  readonly planRuleEvaluatedActions?: readonly string[] | undefined;
}

/** Source precedence order — index 0 is highest priority. */
export const SOURCE_PRECEDENCE: readonly RuleSource[] = [
  "policy",
  "project",
  "local",
  "user",
] as const;

/**
 * Actions explicitly allowed in plan mode.
 * Plan mode is deny-by-default — only these read-only actions are permitted.
 * Exported as a frozen array — internal code creates Sets from these as needed.
 */
export const PLAN_ALLOWED_ACTIONS: readonly string[] = Object.freeze([
  "read",
  "glob",
  "grep",
  "search",
  "list",
]);

/**
 * Actions evaluated against rules in plan mode but NOT auto-allowed.
 * These require an explicit allow rule to proceed; unmatched queries
 * return ask.
 */
export const PLAN_RULE_EVALUATED_ACTIONS: readonly string[] = Object.freeze(["discover"]);

/**
 * Complete vocabulary of actions approved for use in plan mode.
 * Custom planAllowedActions and planRuleEvaluatedActions must be
 * subsets of this set. Any action not in this vocabulary is rejected
 * at construction time, preventing unknown/mutating actions from
 * being silently admitted.
 *
 * To add a new safe action, add it here first.
 */
/**
 * Complete vocabulary of actions approved for use in plan mode.
 * Exported as a frozen array — createPermissionBackend creates
 * a private Set from this for validation.
 */
export const PLAN_SAFE_VOCABULARY: readonly string[] = Object.freeze([
  // Auto-allowed read-only actions
  "read",
  "glob",
  "grep",
  "search",
  "list",
  // Rule-evaluated actions
  "discover",
  // Additional safe actions that callers may add
  "stat",
  "metadata",
  "lookup",
  "describe",
  "inspect",
  "resolve",
]);
