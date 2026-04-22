/**
 * Configuration types and validation for @koi/middleware-permissions.
 */

import type { AuditSink } from "@koi/core";
import type { JsonObject } from "@koi/core/common";
import type { KoiError, Result } from "@koi/core/errors";
import type { PermissionBackend } from "@koi/core/permission-backend";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import type { CircuitBreakerConfig } from "@koi/errors";

import type { ApprovalStore } from "./approval-store.js";

// ---------------------------------------------------------------------------
// Cache config
// ---------------------------------------------------------------------------

export interface PermissionCacheConfig {
  /** TTL for cached allow decisions. Default: 300_000 (5 min). */
  readonly allowTtlMs?: number;
  /** TTL for cached deny decisions. Default: 10_000 (10 sec). */
  readonly denyTtlMs?: number;
  /** Max cached entries. Default: 1024. */
  readonly maxEntries?: number;
}

export interface ApprovalCacheConfig {
  /** TTL for cached human approvals. Default: 300_000 (5 min). 0 = no expiry. */
  readonly ttlMs?: number;
  /** Max cached approvals. Default: 256. */
  readonly maxEntries?: number;
}

export interface DenialEscalationConfig {
  /** Auto-deny after this many denials per tool per session. Default: 3. */
  readonly threshold?: number;
  /** Time window in ms — only denials within this window count. Default: 300_000 (5 min). 0 = no expiry. */
  readonly windowMs?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CACHE_CONFIG: Required<PermissionCacheConfig> = {
  // Short allow TTL (30s) limits the stale-authorization window when
  // policies are revoked mid-session. Increase for immutable backends.
  allowTtlMs: 30_000,
  denyTtlMs: 10_000,
  maxEntries: 1024,
} as const;

export const DEFAULT_APPROVAL_CACHE_TTL_MS: number = 300_000;
export const DEFAULT_APPROVAL_CACHE_MAX_ENTRIES: number = 256;

/**
 * Default approval timeout — 30s fail-closed deny. Agent-to-agent callers
 * and non-interactive flows use this default so a stuck/disconnected
 * approval handler never wedges a turn indefinitely.
 *
 * Interactive TUIs that want unbounded user-decision time must opt in
 * explicitly by passing `approvalTimeoutMs: Number.POSITIVE_INFINITY`
 * (see `packages/meta/cli/src/tui-runtime.ts` for the TUI wiring). (#1759)
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS: number = 30_000;

export const DEFAULT_DENIAL_ESCALATION_THRESHOLD: number = 3;
export const DEFAULT_DENIAL_ESCALATION_WINDOW_MS: number = 300_000;

export const DEFAULT_SOFT_DENY_PER_TURN_CAP: number = 3;

// ---------------------------------------------------------------------------
// Middleware config
// ---------------------------------------------------------------------------

export interface PermissionsMiddlewareConfig {
  /** Pluggable authorization backend. Required. */
  readonly backend: PermissionBackend;
  /** Timeout in ms before auto-deny on ask decisions. Default: 30_000. */
  readonly approvalTimeoutMs?: number;
  /** Enable/configure decision caching. Default: false. */
  readonly cache?: boolean | PermissionCacheConfig;
  /** Enable/configure approval caching. Default: false. */
  readonly approvalCache?: boolean | ApprovalCacheConfig;
  /** Human-readable description for capability fragment. */
  readonly description?: string;
  /** Injectable clock for deterministic testing. Default: Date.now. */
  readonly clock?: () => number;
  /** Structured audit logging sink. Fire-and-forget. */
  readonly auditSink?: AuditSink;
  /** Circuit breaker config for remote backends. */
  readonly circuitBreaker?: CircuitBreakerConfig;
  /** Auto-deny after repeated denials per tool per session. Default: disabled. */
  readonly denialEscalation?: boolean | DenialEscalationConfig;
  /** Callback emitted after each approval decision, producing a source:"user" trajectory step. */
  readonly onApprovalStep?: (sessionId: string, step: RichTrajectoryStep) => void;
  /**
   * Persistent approval store for cross-session "always" grants.
   * When configured, "always-allow" decisions are persisted to SQLite and
   * survive process restart. Constructed externally via `createApprovalStore`.
   */
  readonly persistentApprovals?: ApprovalStore;
  /**
   * Stable agent identifier for persistent grant keys. When set, persistent
   * "always" grants are keyed by this value instead of the per-process agentId
   * (which is a random UUID, regenerated on each restart).
   *
   * This is required for persistent grants to work across TUI/CLI restarts,
   * where the manifest name (e.g. "koi-tui") identifies the logical agent
   * while ctx.session.agentId changes every launch.
   *
   * When unset, persistent grants use ctx.session.agentId (unstable across
   * restarts — useful only for multi-agent runtimes where each agent has a
   * durable identity managed externally).
   */
  readonly persistentAgentId?: string;
  /**
   * Optional path resolver for filesystem tools. When set, the middleware
   * extracts the resolved absolute path from tool input and injects it as
   * `context.path` in the PermissionQuery. This enables path-based rules:
   *
   *   { pattern: "fs_read", context: { path: "/Users/foo/project/**" }, effect: "allow" }
   *
   * The callback receives the tool ID and input object. Return the resolved
   * absolute path for tools that have a path argument, or undefined for
   * tools that don't (non-fs tools, missing path arg, etc.).
   */
  readonly resolveToolPath?:
    | ((toolId: string, input: JsonObject) => string | undefined)
    | undefined;
  /**
   * Optional bash-command resolver. When set, the middleware extracts the
   * raw command string from a tool's input and derives the canonical
   * permission prefix via `@koi/bash-classifier#prefix()`. The resource key
   * passed to the backend becomes `<toolId>:<prefix>`, e.g. `bash:git push`
   * or `shell:npm run build` — enabling rules like
   *
   *   { allow: ["bash:git push", "bash:git status"], deny: ["bash:rm*"] }
   *
   * The callback receives the tool ID and input object. Return the raw
   * command string for bash-like tools, or `undefined` for tools that do
   * not carry a shell command. Returning an empty or whitespace-only
   * string falls back to the plain tool name.
   *
   * Asymmetry note: enrichment only runs at `wrapToolCall` (execution
   * time), not at `wrapModelCall` (tool-list filter). Tool listing uses
   * the plain tool name because the model has not chosen a command yet.
   */
  readonly resolveBashCommand?:
    | ((toolId: string, input: JsonObject) => string | undefined)
    | undefined;
  /**
   * Optional context resolver for bash grant keys. Return a stable
   * identifier for the execution environment — typically cwd, repo
   * root, or a tenant/workspace id. The returned string is hashed
   * into the grant key so approvals stay scoped to the context they
   * were granted in. Without this, approving `git push` in one repo
   * silently authorizes the same text in another repo/tenant.
   *
   * Receives the same arguments as `resolveBashCommand`. Return
   * `undefined` to opt out of context-scoping for this invocation
   * (grant key reverts to command-only scope — documented caveat).
   *
   * No effect when `resolveBashCommand` is not configured.
   */
  readonly resolveBashContext?:
    | ((toolId: string, input: JsonObject) => string | undefined)
    | undefined;
  /**
   * Tool IDs that should stay visible to the model regardless of
   * model-time tool filtering. When set alongside `resolveBashCommand`,
   * prefix-based rules like `{ allow: ["bash:git push"] }` can be
   * enforced at execution time even when the operator has not also
   * written a plain-tool-id allow rule.
   *
   * Without this hint, the default-deny model-time filter would strip
   * `bash` from the tool list (no rule matches the plain tool id),
   * which makes the execution-time prefix rules unreachable. The
   * common pattern: set `bashVisibleTools: ["bash"]` so the bash tool
   * always passes filter, then rely on `resolveBashCommand` +
   * prefix-based rules to gate specific commands at execution.
   *
   * No effect when `resolveBashCommand` is not configured.
   */
  readonly bashVisibleTools?: readonly string[];
  /**
   * Migration aid for deployments that enabled `resolveBashCommand`
   * after already persisting plain-tool-id `bash` approvals under the
   * old (pre-enrichment) keying. When `true`, the persistent-approval
   * lookup falls back to the legacy plain-tool grant key for commands
   * that are not classified as `!complex` (structural) or dangerous
   * (known-unsafe pattern). Complex/dangerous forms always require a
   * fresh approval regardless of this flag.
   *
   * Default: `false` (strict). New deployments keep the secure
   * default; operators rotating in prefix policy flip this to `true`
   * during the migration window, then back to `false` once users have
   * rekeyed their durable grants.
   *
   * Security note: enabling this trades some policy freshness for
   * continuity. Prefer a scheduled migration (one-time script that
   * rekeys or expires old grants) over leaving this permanently on.
   */
  readonly legacyBashGrantFallback?: boolean;
  /**
   * Opt-in compatibility flag for legacy `PermissionBackend`
   * implementations that do not set `supportsDefaultDenyMarker: true`.
   *
   * When `resolveBashCommand` is configured, dual-key evaluation
   * requires the backend to distinguish default-deny from explicit
   * deny. Backends without the marker cannot participate in the
   * merge, so the middleware has three options:
   *   1. Throw at construction (strict; rollout-hostile).
   *   2. Silently fall back to plain-tool-only evaluation (downgrades
   *      policy without the operator knowing; this is a security
   *      regression).
   *   3. Require explicit opt-in via this flag.
   *
   * We pick (3). Setting this to `true` acknowledges that prefix
   * rules like `ask: bash:git push` will NOT be enforced against
   * this backend — only plain-tool-id rules (e.g. `allow: bash`)
   * apply. The middleware still emits a warning.
   *
   * Default: `false`. Configuring `resolveBashCommand` with a
   * non-marker backend without setting this flag is a fail-closed
   * construction error.
   */
  readonly allowLegacyBackendBashFallback?: boolean;
  /**
   * Max cumulative soft denies per `decisionCacheKey` per turn before hard-throw.
   * Counter is cumulative per turn — allow decisions do not reset it. Cleared at
   * turn boundary via `onBeforeTurn`. Default: 3. #1650.
   */
  readonly softDenyPerTurnCap?: number;
  /**
   * Enable bash-ast spec-aware enforcement. Defaults to `true` when
   * `resolveBashCommand` is configured. Set to `false` to use legacy
   * prefix-only enforcement.
   */
  readonly enableBashSpecGuard?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function fail(message: string): Result<never, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: false,
    },
  };
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && value >= 0;
}

export function validatePermissionsConfig(input: unknown): Result<PermissionsMiddlewareConfig> {
  if (input === null || typeof input !== "object") {
    return fail("config must be a non-null object");
  }

  const config = input as Record<string, unknown>;

  // backend is required and must have a check method
  if (
    config.backend === null ||
    config.backend === undefined ||
    typeof config.backend !== "object"
  ) {
    return fail("config.backend is required and must be an object");
  }

  const backend = config.backend as Record<string, unknown>;
  if (typeof backend.check !== "function") {
    return fail("config.backend.check must be a function");
  }

  // approvalTimeoutMs — positive number if set
  if (config.approvalTimeoutMs !== undefined && !isPositiveNumber(config.approvalTimeoutMs)) {
    return fail("config.approvalTimeoutMs must be a positive number");
  }

  // cache — boolean or PermissionCacheConfig
  if (config.cache !== undefined && typeof config.cache !== "boolean") {
    if (typeof config.cache !== "object" || config.cache === null) {
      return fail("config.cache must be a boolean or PermissionCacheConfig object");
    }
    const cache = config.cache as Record<string, unknown>;
    if (cache.maxEntries !== undefined && !isPositiveNumber(cache.maxEntries)) {
      return fail("config.cache.maxEntries must be a positive number");
    }
    if (cache.allowTtlMs !== undefined && !isNonNegativeNumber(cache.allowTtlMs)) {
      return fail("config.cache.allowTtlMs must be a non-negative number");
    }
    if (cache.denyTtlMs !== undefined && !isNonNegativeNumber(cache.denyTtlMs)) {
      return fail("config.cache.denyTtlMs must be a non-negative number");
    }
  }

  // approvalCache — boolean or ApprovalCacheConfig
  if (config.approvalCache !== undefined && typeof config.approvalCache !== "boolean") {
    if (typeof config.approvalCache !== "object" || config.approvalCache === null) {
      return fail("config.approvalCache must be a boolean or ApprovalCacheConfig object");
    }
    const ac = config.approvalCache as Record<string, unknown>;
    if (ac.maxEntries !== undefined && !isPositiveNumber(ac.maxEntries)) {
      return fail("config.approvalCache.maxEntries must be a positive number");
    }
    if (ac.ttlMs !== undefined && !isNonNegativeNumber(ac.ttlMs)) {
      return fail("config.approvalCache.ttlMs must be a non-negative number");
    }
  }

  // denialEscalation — boolean or DenialEscalationConfig
  if (config.denialEscalation !== undefined && typeof config.denialEscalation !== "boolean") {
    if (typeof config.denialEscalation !== "object" || config.denialEscalation === null) {
      return fail("config.denialEscalation must be a boolean or DenialEscalationConfig object");
    }
    const de = config.denialEscalation as Record<string, unknown>;
    if (de.threshold !== undefined && !isPositiveNumber(de.threshold)) {
      return fail("config.denialEscalation.threshold must be a positive number");
    }
    if (de.windowMs !== undefined && !isNonNegativeNumber(de.windowMs)) {
      return fail("config.denialEscalation.windowMs must be a non-negative number");
    }
  }

  // auditSink — object with log method
  if (config.auditSink !== undefined) {
    if (typeof config.auditSink !== "object" || config.auditSink === null) {
      return fail("config.auditSink must be an object");
    }
    const sink = config.auditSink as Record<string, unknown>;
    if (typeof sink.log !== "function") {
      return fail("config.auditSink.log must be a function");
    }
  }

  // circuitBreaker — all fields positive numbers
  if (config.circuitBreaker !== undefined) {
    if (typeof config.circuitBreaker !== "object" || config.circuitBreaker === null) {
      return fail("config.circuitBreaker must be an object");
    }
    const cb = config.circuitBreaker as Record<string, unknown>;
    if (!isPositiveNumber(cb.failureThreshold)) {
      return fail("config.circuitBreaker.failureThreshold must be a positive number");
    }
    if (!isPositiveNumber(cb.cooldownMs)) {
      return fail("config.circuitBreaker.cooldownMs must be a positive number");
    }
    if (!isPositiveNumber(cb.failureWindowMs)) {
      return fail("config.circuitBreaker.failureWindowMs must be a positive number");
    }
  }

  // onApprovalStep — must be a function if set
  if (config.onApprovalStep !== undefined && typeof config.onApprovalStep !== "function") {
    return fail("config.onApprovalStep must be a function");
  }

  // persistentApprovals — object with has/grant/revoke methods
  if (config.persistentApprovals !== undefined) {
    if (typeof config.persistentApprovals !== "object" || config.persistentApprovals === null) {
      return fail("config.persistentApprovals must be an object");
    }
    const store = config.persistentApprovals as Record<string, unknown>;
    if (typeof store.has !== "function") {
      return fail("config.persistentApprovals.has must be a function");
    }
    if (typeof store.grant !== "function") {
      return fail("config.persistentApprovals.grant must be a function");
    }
    if (typeof store.revoke !== "function") {
      return fail("config.persistentApprovals.revoke must be a function");
    }
  }

  // persistentAgentId — non-empty string if set
  if (config.persistentAgentId !== undefined) {
    if (typeof config.persistentAgentId !== "string" || config.persistentAgentId.length === 0) {
      return fail("config.persistentAgentId must be a non-empty string");
    }
  }

  // resolveToolPath — function if set
  if (config.resolveToolPath !== undefined && typeof config.resolveToolPath !== "function") {
    return fail("config.resolveToolPath must be a function");
  }

  // resolveBashCommand — function if set
  if (config.resolveBashCommand !== undefined && typeof config.resolveBashCommand !== "function") {
    return fail("config.resolveBashCommand must be a function");
  }

  // resolveBashContext — function if set
  if (config.resolveBashContext !== undefined && typeof config.resolveBashContext !== "function") {
    return fail("config.resolveBashContext must be a function");
  }

  // bashVisibleTools — array of non-empty strings if set
  if (config.bashVisibleTools !== undefined) {
    if (!Array.isArray(config.bashVisibleTools)) {
      return fail("config.bashVisibleTools must be an array of strings");
    }
    for (const t of config.bashVisibleTools) {
      if (typeof t !== "string" || t.length === 0) {
        return fail("config.bashVisibleTools entries must be non-empty strings");
      }
    }
  }

  // legacyBashGrantFallback — boolean if set
  if (
    config.legacyBashGrantFallback !== undefined &&
    typeof config.legacyBashGrantFallback !== "boolean"
  ) {
    return fail("config.legacyBashGrantFallback must be a boolean");
  }

  // allowLegacyBackendBashFallback — boolean if set
  if (
    config.allowLegacyBackendBashFallback !== undefined &&
    typeof config.allowLegacyBackendBashFallback !== "boolean"
  ) {
    return fail("config.allowLegacyBackendBashFallback must be a boolean");
  }

  // Cross-field invariant: `resolveBashCommand` requires a marker-aware
  // backend unless the operator explicitly opts into single-key
  // fallback. Mirror the constructor check here so validation catches
  // the misconfiguration up front instead of at runtime.
  if (
    config.resolveBashCommand !== undefined &&
    backend.supportsDefaultDenyMarker !== true &&
    config.allowLegacyBackendBashFallback !== true
  ) {
    return fail(
      "config.resolveBashCommand requires a PermissionBackend with " +
        "`supportsDefaultDenyMarker: true` (mark fall-through denies with the " +
        "IS_DEFAULT_DENY symbol or a public `default: true` field), or explicit " +
        "opt-in via `allowLegacyBackendBashFallback: true` (prefix rules will " +
        "NOT be enforced under that opt-in).",
    );
  }

  // softDenyPerTurnCap — positive number if set
  if (config.softDenyPerTurnCap !== undefined && !isPositiveNumber(config.softDenyPerTurnCap)) {
    return fail("config.softDenyPerTurnCap must be a positive number");
  }

  return { ok: true, value: config as unknown as PermissionsMiddlewareConfig };
}
