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
 * Any action not in this set is denied.
 */
export const PLAN_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "search",
  "list",
]) as ReadonlySet<string>;

/**
 * Actions evaluated against rules in plan mode but NOT auto-allowed.
 * These require an explicit allow rule to proceed; unmatched queries
 * return ask. This prevents both hard-denying useful operations
 * (like discover) and silently allowing them without policy.
 */
export const PLAN_RULE_EVALUATED_ACTIONS: ReadonlySet<string> = new Set([
  "discover",
]) as ReadonlySet<string>;
