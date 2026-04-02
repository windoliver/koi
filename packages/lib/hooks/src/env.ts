/**
 * Environment variable substitution for hook config values.
 *
 * Expands `${VAR_NAME}` patterns in strings using `process.env`.
 * Rejects unresolved variables to fail closed on misconfiguration —
 * hooks should not silently run with empty auth headers or signing keys.
 *
 * Supports a double-whitelist model: per-hook `allowedEnvVars` declares
 * which vars a hook needs, and a system-wide `HookEnvPolicy` restricts
 * which vars any hook may access. A var must pass both to be expanded.
 */

import type { HookEnvPolicy } from "@koi/core";

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// ---------------------------------------------------------------------------
// Glob matching for env-var policy patterns
// ---------------------------------------------------------------------------

/**
 * Match an env var name against a simple glob pattern.
 * Supports `*` (zero or more chars) and `?` (exactly one char).
 */
export function matchEnvGlob(pattern: string, name: string): boolean {
  // Escape regex special chars, then convert glob wildcards
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(name);
}

// ---------------------------------------------------------------------------
// Allow-set builder
// ---------------------------------------------------------------------------

/**
 * Build the effective set of allowed env var names from per-hook and
 * policy-level allowlists.
 *
 * - Both undefined → undefined (no restriction, backward compat)
 * - Hook-only → set of those exact names
 * - Policy-only → empty set (hook must declare allowedEnvVars when policy is active)
 * - Both → hook vars filtered to those matching at least one policy pattern
 */
export function buildEnvAllowSet(
  hookAllowedVars: readonly string[] | undefined,
  policy: HookEnvPolicy | undefined,
): ReadonlySet<string> | undefined {
  if (hookAllowedVars === undefined && policy === undefined) {
    return undefined;
  }

  if (hookAllowedVars !== undefined && policy === undefined) {
    return new Set(hookAllowedVars);
  }

  if (hookAllowedVars === undefined && policy !== undefined) {
    // Policy is active but hook didn't declare allowedEnvVars — deny all.
    // Hooks must explicitly list the vars they need when a policy is in effect.
    return new Set<string>();
  }

  // Both defined — intersection: hook var must match at least one policy pattern
  // At this point both are guaranteed defined by the exhaustive checks above.
  const allowed = new Set<string>();
  if (hookAllowedVars !== undefined && policy !== undefined) {
    for (const varName of hookAllowedVars) {
      if (policy.allowedPatterns.some((p) => matchEnvGlob(p, varName))) {
        allowed.add(varName);
      }
    }
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// Env-var expansion
// ---------------------------------------------------------------------------

/** Successful expansion result. */
interface EnvExpandOk {
  readonly ok: true;
  readonly value: string;
}

/** Failed expansion result — lists missing and denied var names. */
interface EnvExpandError {
  readonly ok: false;
  readonly missing: readonly string[];
  readonly denied: readonly string[];
}

/** Result of env-var expansion. */
export type EnvExpandResult = EnvExpandOk | EnvExpandError;

/**
 * Expand `${VAR}` references in a string using process.env.
 * Returns the expanded string, or an error listing unresolved and denied variable names.
 *
 * @param value - String containing `${VAR}` patterns
 * @param allowedVars - Optional set of allowed var names. When defined, vars not
 *   in the set are denied even if present in process.env. Undefined = no restriction.
 */
export function expandEnvVars(
  value: string,
  allowedVars?: ReadonlySet<string> | undefined,
): EnvExpandResult {
  const missing: string[] = [];
  const denied: string[] = [];

  const expanded = value.replace(ENV_VAR_PATTERN, (_, name: string) => {
    // Check allowlist first (fail closed)
    if (allowedVars !== undefined && !allowedVars.has(name)) {
      denied.push(name);
      return "";
    }
    const resolved = process.env[name];
    if (resolved === undefined) {
      missing.push(name);
      return "";
    }
    return resolved;
  });

  if (missing.length > 0 || denied.length > 0) {
    return { ok: false, missing, denied };
  }
  return { ok: true, value: expanded };
}

/** Successful record expansion result. */
interface EnvRecordExpandOk {
  readonly ok: true;
  readonly value: Record<string, string>;
}

/** Failed record expansion result. */
interface EnvRecordExpandError {
  readonly ok: false;
  readonly missing: readonly string[];
  readonly denied: readonly string[];
}

/** Result of record env-var expansion. */
export type EnvRecordExpandResult = EnvRecordExpandOk | EnvRecordExpandError;

/**
 * Expand env vars in all values of a string record.
 * Returns the expanded record, or an error listing unresolved and denied variable names.
 *
 * @param record - Record with string values that may contain `${VAR}` patterns
 * @param allowedVars - Optional set of allowed var names. Undefined = no restriction.
 */
export function expandEnvVarsInRecord(
  record: Readonly<Record<string, string>>,
  allowedVars?: ReadonlySet<string> | undefined,
): EnvRecordExpandResult {
  const result: Record<string, string> = {};
  const allMissing: string[] = [];
  const allDenied: string[] = [];

  for (const [key, val] of Object.entries(record)) {
    const expanded = expandEnvVars(val, allowedVars);
    if (!expanded.ok) {
      allMissing.push(...expanded.missing);
      allDenied.push(...expanded.denied);
      result[key] = "";
    } else {
      result[key] = expanded.value;
    }
  }

  if (allMissing.length > 0 || allDenied.length > 0) {
    return { ok: false, missing: allMissing, denied: allDenied };
  }
  return { ok: true, value: result };
}
