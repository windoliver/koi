/**
 * Scope enforcement — pluggable policy backend for subsystem access checks.
 *
 * Default enforcement lives in `@koi/scope` (local compiled patterns).
 * Alternative backends (SQLite, Nexus ReBAC, custom) implement this interface
 * for centralized or external policy evaluation.
 */

// ---------------------------------------------------------------------------
// Subsystem identifier
// ---------------------------------------------------------------------------

/** The four scoped infrastructure subsystems. */
export type ScopeSubsystem = "filesystem" | "browser" | "credentials" | "memory";

// ---------------------------------------------------------------------------
// Access request — what is being asked
// ---------------------------------------------------------------------------

/**
 * Describes a single access check against a scope enforcer.
 *
 * The enforcer decides allow/deny based on its own policy (local patterns,
 * database lookup, HTTP call to a ReBAC server, etc.).
 */
export interface ScopeAccessRequest {
  /** Which infrastructure subsystem is being accessed. */
  readonly subsystem: ScopeSubsystem;
  /** The operation being performed (e.g., "read", "write", "navigate", "get", "store"). */
  readonly operation: string;
  /** The resource being accessed (normalized path, URL, key, namespace). */
  readonly resource: string;
  /** Optional additional context for the enforcer. */
  readonly context?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Enforcer interface
// ---------------------------------------------------------------------------

/**
 * Pluggable enforcement backend for scope access checks.
 *
 * Returns `boolean` for sync backends (local patterns) or `Promise<boolean>`
 * for async backends (HTTP, database). Callers must always `await` the result.
 */
export interface ScopeEnforcer {
  /** Check whether the given access request is allowed. */
  readonly checkAccess: (request: ScopeAccessRequest) => boolean | Promise<boolean>;
  /** Optional cleanup for stateful enforcers (connection pools, timers). */
  readonly dispose?: () => void | Promise<void>;
}
