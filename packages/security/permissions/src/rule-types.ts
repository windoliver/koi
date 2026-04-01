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

/** A sourced rule with its glob pattern pre-compiled to a RegExp. */
export interface CompiledRule extends SourcedRule {
  readonly compiled: RegExp;
}

/**
 * Permission mode controls the overall decision strategy:
 * - `"default"` — evaluate rules; fall back to ask
 * - `"bypass"`  — always allow (CI / trusted automation)
 * - `"plan"`    — deny write actions; allow reads
 * - `"auto"`    — evaluate rules; fall back to allow (classifier refines later)
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
