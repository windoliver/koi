/**
 * Permissions middleware — sole interposition layer for tool-level access control.
 *
 * Two interception points:
 * - wrapModelCall: batch-checks all tools, filters denied ones from LLM context
 * - wrapToolCall: re-checks at invocation, handles ask → approval flow
 *
 * Supports decision caching, approval caching, audit logging, circuit breaker,
 * and denial tracking.
 */

import type { AuditEntry, AuditSink } from "@koi/core";
import type { JsonObject } from "@koi/core/common";
import type {
  ApprovalHandler,
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import {
  type CircuitBreaker,
  createCircuitBreaker,
  KoiRuntimeError,
  swallowError,
} from "@koi/errors";
// fnv1a no longer used for cache keys (collision-unsafe for security decisions)
// isDefaultDeny no longer used — forged-tool bypass removed in v2
import type {
  ApprovalCacheConfig,
  PermissionCacheConfig,
  PermissionsMiddlewareConfig,
} from "./config.js";
import {
  DEFAULT_APPROVAL_CACHE_MAX_ENTRIES,
  DEFAULT_APPROVAL_CACHE_TTL_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_CACHE_CONFIG,
  DEFAULT_DENIAL_ESCALATION_THRESHOLD,
  DEFAULT_DENIAL_ESCALATION_WINDOW_MS,
} from "./config.js";
import { createDenialTracker, type DenialTracker } from "./denial-tracker.js";

// ---------------------------------------------------------------------------
// Internal cache types
// ---------------------------------------------------------------------------

interface DecisionCacheEntry {
  readonly decision: PermissionDecision;
  readonly expiresAt: number;
}

interface ApprovalCacheEntry {
  readonly cachedAt: number;
}

// ---------------------------------------------------------------------------
// Decision cache
// ---------------------------------------------------------------------------

function createDecisionCache(
  config: PermissionCacheConfig,
  clock: () => number,
): {
  readonly get: (key: string) => PermissionDecision | undefined;
  readonly set: (key: string, decision: PermissionDecision) => void;
  readonly clear: () => void;
} {
  const maxEntries = config.maxEntries ?? DEFAULT_CACHE_CONFIG.maxEntries;
  const allowTtl = config.allowTtlMs ?? DEFAULT_CACHE_CONFIG.allowTtlMs;
  const denyTtl = config.denyTtlMs ?? DEFAULT_CACHE_CONFIG.denyTtlMs;
  // String keys: collision-safe for security-sensitive authorization decisions
  const entries = new Map<string, DecisionCacheEntry>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      // expiresAt === Infinity means no expiry (ttl was 0)
      if (entry.expiresAt !== Infinity && clock() >= entry.expiresAt) {
        entries.delete(key);
        return undefined;
      }
      // LRU: move to end
      entries.delete(key);
      entries.set(key, entry);
      return entry.decision;
    },

    set(key, decision) {
      // Never cache "ask" decisions
      if (decision.effect === "ask") return;

      const ttl = decision.effect === "allow" ? allowTtl : denyTtl;
      // Evict oldest if full
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      // ttl === 0 means no expiry (permanent cache until eviction or clear)
      entries.set(key, { decision, expiresAt: ttl === 0 ? Infinity : clock() + ttl });
    },

    clear() {
      entries.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Approval cache
// ---------------------------------------------------------------------------

function createApprovalCache(
  config: ApprovalCacheConfig,
  clock: () => number,
): {
  readonly has: (key: string) => boolean;
  readonly set: (key: string) => void;
  readonly clear: () => void;
} {
  const maxEntries = config.maxEntries ?? DEFAULT_APPROVAL_CACHE_MAX_ENTRIES;
  const ttlMs = config.ttlMs ?? DEFAULT_APPROVAL_CACHE_TTL_MS;
  // String keys: collision-safe for security-sensitive approval decisions
  const entries = new Map<string, ApprovalCacheEntry>();

  return {
    has(key) {
      const entry = entries.get(key);
      if (entry === undefined) return false;
      if (ttlMs > 0 && clock() - entry.cachedAt >= ttlMs) {
        entries.delete(key);
        return false;
      }
      // LRU: move to end
      entries.delete(key);
      entries.set(key, entry);
      return true;
    },

    set(key) {
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { cachedAt: clock() });
    },

    clear() {
      entries.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Decision validation (fail-closed on malformed backend responses)
// ---------------------------------------------------------------------------

const VALID_EFFECTS = new Set(["allow", "deny", "ask"]);

/** Symbol to tag fail-closed denials so escalation can exclude them. */
const IS_FAIL_CLOSED: unique symbol = Symbol.for("@koi/middleware-permissions/fail-closed");

const FAIL_CLOSED_DENY: PermissionDecision = Object.freeze({
  effect: "deny",
  reason: "Malformed backend decision — failing closed",
  [IS_FAIL_CLOSED]: true,
} as PermissionDecision);

function isFailClosed(decision: PermissionDecision): boolean {
  return (decision as Record<symbol, unknown>)[IS_FAIL_CLOSED] === true;
}

function failClosedDeny(reason: string): PermissionDecision {
  return Object.freeze({
    effect: "deny",
    reason,
    [IS_FAIL_CLOSED]: true,
  } as PermissionDecision);
}

/** Symbol to tag escalation-generated denials so they don't self-sustain. */
const IS_ESCALATED: unique symbol = Symbol.for("@koi/middleware-permissions/escalated");

function isEscalated(decision: PermissionDecision): boolean {
  return (decision as Record<symbol, unknown>)[IS_ESCALATED] === true;
}

/** Symbol to tag cached deny replays so they don't inflate escalation counts. */
const IS_CACHED: unique symbol = Symbol.for("@koi/middleware-permissions/cached");

function isCached(decision: PermissionDecision): boolean {
  return (decision as Record<symbol, unknown>)[IS_CACHED] === true;
}

function tagCached(decision: PermissionDecision): PermissionDecision {
  if (decision.effect !== "deny") return decision;
  return { ...decision, [IS_CACHED]: true } as PermissionDecision;
}

/** Determine denial source for tracker recording. Only "policy" counts toward escalation. */
/** Safely serialize a value to a JSON preview string, truncated to maxLen. */
function safePreviewJson(value: unknown, maxLen: number): string {
  try {
    const s = JSON.stringify(value);
    return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
  } catch {
    return "[unserializable]";
  }
}

function denialSource(
  decision: PermissionDecision,
): "policy" | "backend-error" | "escalation" | "approval" {
  if (isFailClosed(decision)) return "backend-error";
  if (isEscalated(decision)) return "escalation";
  if (isCached(decision)) return "escalation"; // cached replays must not inflate escalation
  return "policy";
}

/**
 * Validate a backend decision at the trust boundary. Malformed or
 * unexpected shapes are converted to deny (fail-closed) rather than
 * silently falling through to allow.
 */
function validateDecision(raw: unknown): PermissionDecision {
  if (raw === null || typeof raw !== "object") return FAIL_CLOSED_DENY;
  const obj = raw as Record<string, unknown>;
  if (!VALID_EFFECTS.has(obj.effect as string)) return FAIL_CLOSED_DENY;
  if (obj.effect === "deny" || obj.effect === "ask") {
    if (typeof obj.reason !== "string") return FAIL_CLOSED_DENY;
  }
  return raw as PermissionDecision;
}

const VALID_APPROVAL_KINDS = new Set(["allow", "always-allow", "deny", "modify"]);
const VALID_ALWAYS_ALLOW_SCOPES = new Set(["session", "always"]);

/**
 * Validate an approval handler response at the trust boundary.
 * Returns the validated decision or undefined if malformed (caller
 * should fail closed).
 */
function validateApprovalDecision(
  raw: unknown,
):
  | { readonly kind: "allow" }
  | { readonly kind: "always-allow"; readonly scope: "session" | "always" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "modify"; readonly updatedInput: Record<string, unknown> }
  | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  if (!VALID_APPROVAL_KINDS.has(obj.kind as string)) return undefined;
  if (obj.kind === "deny") {
    if (typeof obj.reason !== "string") return undefined;
    return { kind: "deny", reason: obj.reason };
  }
  if (obj.kind === "modify") {
    // Must be a plain JSON object — reject null, arrays, and non-objects
    if (
      obj.updatedInput === null ||
      typeof obj.updatedInput !== "object" ||
      Array.isArray(obj.updatedInput)
    ) {
      return undefined;
    }
    return { kind: "modify", updatedInput: obj.updatedInput as Record<string, unknown> };
  }
  if (obj.kind === "always-allow") {
    const scope = obj.scope as string;
    if (!VALID_ALWAYS_ALLOW_SCOPES.has(scope)) return undefined;
    return { kind: "always-allow", scope: scope as "session" | "always" };
  }
  return { kind: "allow" };
}

// ---------------------------------------------------------------------------
// Cache key helpers
// ---------------------------------------------------------------------------

/**
 * Safe JSON serialization — returns undefined on non-serializable values
 * (cyclic objects, BigInt, etc.) instead of throwing.
 */
function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Full serialized key — collision-safe for security-sensitive cache lookups. */
function decisionCacheKey(query: PermissionQuery): string | undefined {
  const ctx = query.context !== undefined ? safeStringify(query.context) : "";
  if (ctx === undefined) return undefined;
  return `${query.principal}\0${query.action}\0${query.resource}\0${ctx}`;
}

/** Full serialized key — collision-safe for approval cache lookups. */
function computeApprovalCacheKey(
  backendFingerprint: string,
  sessionId: string,
  userId: string,
  agentId: string,
  toolId: string,
  input: unknown,
  context: string | undefined,
  requestMeta: unknown,
  approvalReason: string,
): string | undefined {
  if (context === undefined) return undefined;
  const sorted = safeSerializeInput(input);
  if (sorted === undefined) return undefined;
  const reqMeta = requestMeta !== undefined ? safeStringify(requestMeta) : "";
  if (reqMeta === undefined) return undefined;
  // Include approval reason so policy/risk changes invalidate cached approvals
  return `${backendFingerprint}\0${sessionId}\0${userId}\0${agentId}\0${toolId}\0${sorted}\0${context}\0${reqMeta}\0${approvalReason}`;
}

/** Serialize turn-scoped context for inclusion in approval cache keys. */
/** Returns undefined when metadata is not serializable — caller must skip caching. */
function serializeTurnContext(ctx: TurnContext): string | undefined {
  const sessionMeta = ctx.session.metadata;
  const turnMeta = ctx.metadata;
  const hasSession = Object.keys(sessionMeta).length > 0;
  const hasTurn = Object.keys(turnMeta).length > 0;
  if (!hasSession && !hasTurn) return "";
  const combined = { ...(hasSession ? { _s: sessionMeta } : {}), ...(hasTurn ? turnMeta : {}) };
  return safeStringify(combined);
}

function safeSerializeInput(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") {
    return safeStringify(value);
  }
  const obj = value as Record<string, unknown>;
  const sorted = Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = obj[key];
      return acc;
    }, {});
  return safeStringify(sorted);
}

/**
 * Build an unambiguous principal string from structured identity fields.
 * Uses JSON array encoding to prevent separator collisions — e.g. an
 * agentId containing ":" cannot produce the same principal as a
 * different agent/user/session tuple.
 */
function buildPrincipal(agentId: string, userId: string, sessionId: string): string {
  return JSON.stringify([agentId, userId, sessionId]);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const PKG = "@koi/middleware-permissions";

/**
 * Extended middleware returned by {@link createPermissionsMiddleware}.
 *
 * This IS a KoiMiddleware (backward compatible — can be passed directly
 * into `middleware: [...]`) with additional methods for runtime wiring.
 */
export interface PermissionsMiddlewareHandle extends KoiMiddleware {
  /**
   * Register an additional approval-step sink.  The runtime calls this
   * with a dispatch relay that routes to the correct per-stream
   * `EventTraceHandle.emitExternalStep` by sessionId.
   * Additive: multiple sinks can coexist (multi-runtime safe).
   * Returns an unsubscribe function to remove the sink on runtime disposal.
   */
  readonly setApprovalStepSink: (
    sink: (sessionId: string, step: RichTrajectoryStep) => void,
  ) => () => void;
  /**
   * Clear all session-scoped approval state (always-allow grants, decision
   * caches, approval caches, denial trackers) for the given session ID.
   *
   * Call on `agent:clear` / `session:new` so prior-session approvals do not
   * silently carry over into the next conversation.
   */
  readonly clearSessionApprovals: (sessionId: string) => void;
  /**
   * Revoke a persistent always-allow grant. Returns true if a grant existed.
   * No-op if no persistent store is configured.
   */
  readonly revokePersistentApproval: (userId: string, agentId: string, toolId: string) => boolean;
  /**
   * Revoke all persistent always-allow grants.
   * No-op if no persistent store is configured.
   */
  readonly revokeAllPersistentApprovals: () => void;
  /**
   * List all persistent always-allow grants (for UI/diagnostics).
   * Returns empty array if no persistent store is configured.
   */
  readonly listPersistentApprovals: () => readonly import("./approval-store.js").ApprovalGrant[];
}

export function createPermissionsMiddleware(
  config: PermissionsMiddlewareConfig,
): PermissionsMiddlewareHandle {
  const {
    backend,
    auditSink,
    description,
    persistentApprovals: persistentStore,
    persistentAgentId,
  } = config;
  const originalSink = config.onApprovalStep;
  // Additive runtime sinks — each createRuntime registers its own dispatch relay.
  // Using an array allows a single permissions handle to be shared across runtimes.
  const runtimeSinks: ((sessionId: string, step: RichTrajectoryStep) => void)[] = [];

  /** Fan-out: calls the original onApprovalStep and all runtime-bound sinks.
   *  Each sink is isolated — a throw in one cannot suppress another. */
  function approvalSink(sessionId: string, step: RichTrajectoryStep): void {
    if (originalSink !== undefined) {
      try {
        originalSink(sessionId, step);
      } catch (e: unknown) {
        swallowError(e, { package: PKG, operation: "approval-step-original" });
      }
    }
    for (const sink of runtimeSinks) {
      try {
        sink(sessionId, step);
      } catch (e: unknown) {
        swallowError(e, { package: PKG, operation: "approval-step-runtime" });
      }
    }
  }
  const clock = config.clock ?? Date.now;
  const approvalTimeoutMs = config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  // Circuit breaker (optional)
  const cb: CircuitBreaker | undefined =
    config.circuitBreaker !== undefined
      ? createCircuitBreaker(config.circuitBreaker, clock)
      : undefined;

  // Per-session decision caches (created on demand, dropped on session end)
  const cacheConfig =
    config.cache !== undefined && config.cache !== false
      ? typeof config.cache === "object"
        ? config.cache
        : DEFAULT_CACHE_CONFIG
      : undefined;
  const decisionCachesBySession = new Map<string, ReturnType<typeof createDecisionCache>>();

  function getDecisionCache(sessionId: string): ReturnType<typeof createDecisionCache> | undefined {
    if (cacheConfig === undefined) return undefined;
    let c = decisionCachesBySession.get(sessionId);
    if (c === undefined) {
      c = createDecisionCache(cacheConfig, clock);
      decisionCachesBySession.set(sessionId, c);
    }
    return c;
  }

  // Per-session approval caches (created on demand, dropped on session end)
  const approvalCacheConfig =
    config.approvalCache !== undefined && config.approvalCache !== false
      ? typeof config.approvalCache === "object"
        ? config.approvalCache
        : { ttlMs: DEFAULT_APPROVAL_CACHE_TTL_MS, maxEntries: DEFAULT_APPROVAL_CACHE_MAX_ENTRIES }
      : undefined;
  const approvalCachesBySession = new Map<string, ReturnType<typeof createApprovalCache>>();

  // Per-session always-allowed tool IDs (from "always-allow" approval decisions).
  // When a tool is in this set, future calls skip the approval handler entirely.
  //
  // SECURITY NOTE: This is a per-tool bypass — approving "bash" once approves ALL
  // future bash calls in the session regardless of arguments. This is intentional and
  // matches Claude Code's "a" key behavior: the user explicitly opts into blanket
  // tool approval. The tradeoff (convenience vs re-prompting on risky args) is
  // accepted because:
  //   1. The user made an explicit "always" decision (not a default)
  //   2. Every bypass is audit-logged via the denial tracker
  //   3. Session scope limits blast radius (cleared on session end)
  //
  // Future mitigation: a riskReclassifier callback that re-evaluates always-allowed
  // calls and revokes the bypass when input risk exceeds a threshold.
  const alwaysAllowedBySession = new Map<string, Set<string>>();

  function getApprovalCache(sessionId: string): ReturnType<typeof createApprovalCache> | undefined {
    if (approvalCacheConfig === undefined) return undefined;
    let c = approvalCachesBySession.get(sessionId);
    if (c === undefined) {
      c = createApprovalCache(approvalCacheConfig, clock);
      approvalCachesBySession.set(sessionId, c);
    }
    return c;
  }

  // Backend fingerprint for approval cache key isolation (random string per instance)
  const backendFingerprint = String(Math.random());

  // In-flight approval deduplication: concurrent identical ask calls
  // coalesce onto a single pending approval instead of double-prompting
  const inflightApprovals = new Map<string, Promise<unknown>>();

  // Per-session index of in-flight dedup keys — used by clearSessionApprovals
  // to evict all pending approvals for a session on agent:clear / session:new.
  // Without this, a stale dialog approval can still resolve and re-populate
  // the approval cache for what the user expects to be a fresh session.
  const inflightKeysBySession = new Map<string, Set<string>>();

  // Denial trackers scoped per session (keyed by sessionId)
  const trackersBySession = new Map<string, DenialTracker>();

  function getTracker(sessionId: string): DenialTracker {
    let t = trackersBySession.get(sessionId);
    if (t === undefined) {
      t = createDenialTracker();
      trackersBySession.set(sessionId, t);
    }
    return t;
  }

  // Denial escalation config
  const escalationEnabled =
    config.denialEscalation !== undefined && config.denialEscalation !== false;
  const escalationThreshold = escalationEnabled
    ? typeof config.denialEscalation === "object"
      ? (config.denialEscalation.threshold ?? DEFAULT_DENIAL_ESCALATION_THRESHOLD)
      : DEFAULT_DENIAL_ESCALATION_THRESHOLD
    : Infinity;
  const escalationWindowMs = escalationEnabled
    ? typeof config.denialEscalation === "object"
      ? (config.denialEscalation.windowMs ?? DEFAULT_DENIAL_ESCALATION_WINDOW_MS)
      : DEFAULT_DENIAL_ESCALATION_WINDOW_MS
    : 0;

  // Forged-tool default-deny bypass removed (v2): forged tools must be
  // explicitly allowed via backend rules. Name-based bypasses are unsafe
  // because tool identity can change between model filtering and execution.

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Strip ephemeral / per-invocation fields from request metadata before
   * the metadata is used for policy queries, approval cache lookups, or
   * in-flight dedup keys. The TUI threads `callId` through `metadata.callId`
   * so the permission bridge can dispatch a per-call timer reset (#1759),
   * but `callId` is unique per invocation — letting it bleed into the
   * cache/dedup key would defeat approval coalescing for repeated
   * identical asks and could change backend rule outcomes for
   * installations that match on `_request` metadata. Returns the original
   * reference when nothing was stripped (cheap fast path) and `undefined`
   * when stripping leaves the object empty so empty-object metadata still
   * collapses into the no-metadata branch downstream. (#1759 review round)
   */
  function policyMetadataOf(metadata?: JsonObject): JsonObject | undefined {
    if (metadata === undefined) return undefined;
    if (!Object.hasOwn(metadata, "callId")) return metadata;
    const stripped: Record<string, unknown> = {};
    for (const key of Object.keys(metadata)) {
      if (key === "callId") continue;
      stripped[key] = metadata[key];
    }
    return Object.keys(stripped).length === 0 ? undefined : (stripped as JsonObject);
  }

  function queryForTool(
    ctx: TurnContext,
    resource: string,
    requestMetadata?: JsonObject,
  ): PermissionQuery {
    // Build principal with user/session scope for tenant isolation.
    // Uses JSON array encoding to prevent separator collisions.
    const userId = ctx.session.userId ?? "__anonymous__";
    const sessionId = ctx.session.sessionId as string;
    const principal = buildPrincipal(ctx.session.agentId, userId, sessionId);

    // Merge session + turn + per-request metadata into query context.
    // All three layers participate in backend checks and cache keys.
    const sessionMeta = ctx.session.metadata;
    const turnMeta = ctx.metadata;
    const hasSessionMeta = Object.keys(sessionMeta).length > 0;
    const hasTurnMeta = Object.keys(turnMeta).length > 0;
    const hasReqMeta = requestMetadata !== undefined && Object.keys(requestMetadata).length > 0;
    if (hasSessionMeta || hasTurnMeta || hasReqMeta) {
      const merged = {
        ...(hasSessionMeta ? { _session: sessionMeta } : {}),
        ...(hasTurnMeta ? turnMeta : {}),
        ...(hasReqMeta ? { _request: requestMetadata } : {}),
      };
      return { principal, action: "invoke", resource, context: merged };
    }
    return { principal, action: "invoke", resource };
  }

  /** Audit a permission decision at execution time (wrapToolCall). */
  function auditDecision(
    ctx: TurnContext,
    resource: string,
    decision: PermissionDecision,
    durationMs: number,
    sink: AuditSink,
  ): void {
    const entry: AuditEntry = {
      schema_version: 1,
      timestamp: clock(),
      sessionId: ctx.session.sessionId as string,
      agentId: ctx.session.agentId,
      turnIndex: ctx.turnIndex,
      kind: "permission_decision",
      durationMs,
      metadata: {
        permissionCheck: true,
        permissionEvent:
          decision.effect === "ask" ? "asked" : decision.effect === "deny" ? "denied" : "granted",
        phase: "execute",
        resource,
        effect: decision.effect,
        userId: ctx.session.userId ?? "__anonymous__",
        ...(decision.effect !== "allow" ? { reason: decision.reason } : {}),
      },
    };
    void sink.log(entry).catch((e: unknown) => {
      swallowError(e, { package: PKG, operation: "audit" });
    });
  }

  /** Validated approval decision — structural type matching validateApprovalDecision return. */
  type ValidatedApproval =
    | { readonly kind: "allow" }
    | { readonly kind: "always-allow"; readonly scope: "session" | "always" }
    | { readonly kind: "deny"; readonly reason: string }
    | { readonly kind: "modify"; readonly updatedInput: Record<string, unknown> };

  /** Audit an approval outcome. Called both after user responds and on fast-path replay. */
  function auditApprovalOutcome(
    ctx: TurnContext,
    resource: string,
    approval: ValidatedApproval,
    originalInput: JsonObject,
    durationMs: number,
    sink: AuditSink,
    coalesced = false,
    remembered = false,
  ): void {
    // "remembered" = fast-path replay (persistent or session grant matched).
    // "granted" / "denied" = user responded to a prompt.
    const permissionEvent = remembered
      ? "remembered"
      : approval.kind === "deny"
        ? "denied"
        : "granted";
    const meta: Record<string, unknown> = {
      permissionCheck: true,
      permissionEvent,
      phase: "approval_outcome",
      resource,
      approvalDecision: approval.kind,
      userId: ctx.session.userId ?? "__anonymous__",
      ...(coalesced ? { coalesced: true } : {}),
    };
    if (approval.kind === "deny") {
      meta.denyReason = approval.reason;
    }
    if (approval.kind === "modify") {
      // Log key names only — raw inputs may contain secrets or sensitive data.
      // Full payload capture requires a dedicated secure-audit mode.
      meta.originalInputKeys = Object.keys(originalInput).sort();
      meta.modifiedInputKeys = Object.keys(approval.updatedInput).sort();
      meta.inputModified = true;
    }
    if (approval.kind === "always-allow") {
      meta.scope = approval.scope;
    }
    const entry: AuditEntry = {
      schema_version: 1,
      timestamp: clock(),
      sessionId: ctx.session.sessionId as string,
      agentId: ctx.session.agentId,
      turnIndex: ctx.turnIndex,
      kind: "permission_decision",
      durationMs,
      metadata: meta as JsonObject,
    };
    void sink.log(entry).catch((e: unknown) => {
      swallowError(e, { package: PKG, operation: "audit-approval" });
    });
  }

  /** Emit a source:"user" trajectory step for an approval decision. */
  function emitApprovalStep(
    ctx: TurnContext,
    toolId: string,
    approval: ValidatedApproval,
    originalInput: JsonObject,
    startMs: number,
    coalesced = false,
  ): void {
    if (originalSink === undefined && runtimeSinks.length === 0) return;
    const meta: Record<string, unknown> = {
      approvalDecision: approval.kind,
      userId: ctx.session.userId ?? "__anonymous__",
      ...(coalesced ? { coalesced: true } : {}),
    };
    if (approval.kind === "modify") {
      meta.inputModified = true;
      meta.originalInputKeys = Object.keys(originalInput).sort();
      meta.modifiedInputKeys = Object.keys(approval.updatedInput).sort();
    }
    if (approval.kind === "deny") {
      meta.denyReason = approval.reason;
    }
    if (approval.kind === "always-allow") {
      meta.scope = approval.scope;
    }
    const step: RichTrajectoryStep = {
      stepIndex: -1,
      timestamp: startMs,
      source: "user",
      kind: "tool_call",
      identifier: toolId,
      outcome: approval.kind === "deny" ? "failure" : "success",
      durationMs: clock() - startMs,
      metadata: meta as JsonObject,
    };
    try {
      approvalSink(ctx.session.sessionId as string, step);
    } catch (e: unknown) {
      swallowError(e, { package: PKG, operation: "approval-step" });
    }
  }

  /** Audit a permission decision at model-time filtering (wrapModelCall). */
  function auditFilterDecision(
    ctx: TurnContext,
    resource: string,
    decision: PermissionDecision,
    sink: AuditSink,
  ): void {
    const entry: AuditEntry = {
      schema_version: 1,
      timestamp: clock(),
      sessionId: ctx.session.sessionId as string,
      agentId: ctx.session.agentId,
      turnIndex: ctx.turnIndex,
      kind: "permission_decision",
      durationMs: 0,
      metadata: {
        permissionCheck: true,
        phase: "filter",
        resource,
        effect: decision.effect,
        ...(decision.effect !== "allow" ? { reason: decision.reason } : {}),
      },
    };
    void sink.log(entry).catch((e: unknown) => {
      swallowError(e, { package: PKG, operation: "audit" });
    });
  }

  async function resolveDecision(
    query: PermissionQuery,
    sessionId: string,
  ): Promise<PermissionDecision> {
    // Denial escalation: skip backend if this tool+context has enough recent policy denials.
    // If the query context is not serializable (cacheKey undefined), skip escalation
    // entirely — we cannot scope it safely and must not match across contexts.
    if (escalationEnabled) {
      const cacheKey = decisionCacheKey(query);
      if (cacheKey !== undefined) {
        const tracker = getTracker(sessionId);
        const now = clock();
        const cutoff = escalationWindowMs > 0 ? now - escalationWindowMs : 0;
        const recentPolicyDenials = tracker
          .getByTool(query.resource)
          .filter(
            (r) =>
              r.source === "policy" &&
              r.timestamp >= cutoff &&
              (r.queryKey === undefined || r.queryKey === cacheKey),
          );
        if (recentPolicyDenials.length >= escalationThreshold) {
          return {
            effect: "deny",
            reason: `Auto-denied: ${escalationThreshold}+ prior denials this session`,
            [IS_ESCALATED]: true,
          } as PermissionDecision;
        }
      }
    }

    // Circuit breaker check
    if (cb !== undefined && !cb.isAllowed()) {
      return failClosedDeny("Permission backend circuit open — failing closed");
    }

    // Cache check (per-session, skip if key not serializable)
    const decisionCache = getDecisionCache(sessionId);
    const cacheKey = decisionCacheKey(query);
    if (decisionCache !== undefined && cacheKey !== undefined) {
      const cached = decisionCache.get(cacheKey);
      if (cached !== undefined) return tagCached(cached);
    }

    try {
      const raw = await backend.check(query);
      const decision = validateDecision(raw);

      // Malformed response = backend failure for circuit breaker purposes
      if (cb !== undefined) {
        if (decision === FAIL_CLOSED_DENY) {
          cb.recordFailure();
        } else {
          cb.recordSuccess();
        }
      }
      if (decisionCache !== undefined && decision !== FAIL_CLOSED_DENY && cacheKey !== undefined) {
        decisionCache.set(cacheKey, decision);
      }
      return decision;
    } catch (e: unknown) {
      if (cb !== undefined) cb.recordFailure();
      return failClosedDeny(
        `Permission backend error — failing closed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function resolveBatch(
    queries: readonly PermissionQuery[],
    sessionId: string,
  ): Promise<readonly PermissionDecision[]> {
    if (queries.length === 0) return [];

    const decisionCache = getDecisionCache(sessionId);

    // Partition into cached, escalated, and uncached
    const results: (PermissionDecision | undefined)[] = new Array(queries.length).fill(undefined);
    const uncachedIndices: number[] = [];

    // Denial escalation: resolve escalated tools before cache/backend.
    // Skip escalation for queries with non-serializable context (undefined cacheKey).
    if (escalationEnabled) {
      const tracker = getTracker(sessionId);
      const now = clock();
      const cutoff = escalationWindowMs > 0 ? now - escalationWindowMs : 0;
      for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        if (query === undefined) continue;
        const cacheKey = decisionCacheKey(query);
        if (cacheKey === undefined) continue;
        const recentPolicyDenials = tracker
          .getByTool(query.resource)
          .filter(
            (r) =>
              r.source === "policy" &&
              r.timestamp >= cutoff &&
              (r.queryKey === undefined || r.queryKey === cacheKey),
          );
        if (recentPolicyDenials.length >= escalationThreshold) {
          results[i] = {
            effect: "deny",
            reason: `Auto-denied: ${escalationThreshold}+ prior denials this session`,
            [IS_ESCALATED]: true,
          } as PermissionDecision;
        }
      }
    }

    if (decisionCache !== undefined) {
      for (let i = 0; i < queries.length; i++) {
        if (results[i] !== undefined) continue; // already escalated
        const query = queries[i];
        if (query === undefined) continue;
        const key = decisionCacheKey(query);
        const cached = key !== undefined ? decisionCache.get(key) : undefined;
        if (cached !== undefined) {
          results[i] = tagCached(cached);
        } else {
          uncachedIndices.push(i);
        }
      }
    } else {
      for (let i = 0; i < queries.length; i++) {
        if (results[i] !== undefined) continue; // already escalated
        uncachedIndices.push(i);
      }
    }

    if (uncachedIndices.length === 0) {
      return results as readonly PermissionDecision[];
    }

    // Circuit breaker
    if (cb !== undefined && !cb.isAllowed()) {
      const deny = failClosedDeny("Permission backend circuit open — failing closed");
      for (const i of uncachedIndices) {
        results[i] = deny;
      }
      return results as readonly PermissionDecision[];
    }

    // Resolve uncached queries
    // biome-ignore lint/style/noNonNullAssertion: uncachedIndices only contains valid queries indices
    const uncachedQueries = uncachedIndices.map((i) => queries[i]!);
    try {
      let rawDecisions: readonly unknown[];
      if (backend.checkBatch !== undefined) {
        rawDecisions = (await backend.checkBatch(uncachedQueries)) as readonly unknown[];
      } else {
        rawDecisions = (await Promise.all(
          uncachedQueries.map((q) => backend.check(q)),
        )) as readonly unknown[];
      }

      // Validate batch length — fail closed on mismatch (counts as backend failure)
      if (!Array.isArray(rawDecisions) || rawDecisions.length !== uncachedQueries.length) {
        if (cb !== undefined) cb.recordFailure();
        for (const i of uncachedIndices) {
          results[i] = FAIL_CLOSED_DENY;
        }
        return results as readonly PermissionDecision[];
      }

      // Validate all decisions first — any malformed element poisons the
      // entire batch (fail-closed: a corrupted backend response cannot be
      // partially trusted at a permission boundary)
      const validated: PermissionDecision[] = [];
      let hasValidationFailure = false;
      for (let j = 0; j < uncachedIndices.length; j++) {
        const decision = validateDecision(rawDecisions[j]);
        if (decision === FAIL_CLOSED_DENY) hasValidationFailure = true;
        validated.push(decision);
      }

      if (hasValidationFailure) {
        // Poison entire batch — deny all uncached queries, cache nothing
        if (cb !== undefined) cb.recordFailure();
        for (const i of uncachedIndices) {
          results[i] = FAIL_CLOSED_DENY;
        }
      } else {
        if (cb !== undefined) cb.recordSuccess();
        for (let j = 0; j < uncachedIndices.length; j++) {
          // biome-ignore lint/style/noNonNullAssertion: j < uncachedIndices.length && validated.length === uncachedIndices.length
          const idx = uncachedIndices[j]!;
          // biome-ignore lint/style/noNonNullAssertion: j < validated.length (validated built from same loop)
          const decision = validated[j]!;
          results[idx] = decision;
          if (decisionCache !== undefined) {
            // biome-ignore lint/style/noNonNullAssertion: idx is a valid index from uncachedIndices
            const key = decisionCacheKey(queries[idx]!);
            if (key !== undefined) decisionCache.set(key, decision);
          }
        }
      }
    } catch (e: unknown) {
      if (cb !== undefined) cb.recordFailure();
      const deny = failClosedDeny(
        `Permission backend error — failing closed: ${e instanceof Error ? e.message : String(e)}`,
      );
      for (const i of uncachedIndices) {
        results[i] = deny;
      }
    }

    return results as readonly PermissionDecision[];
  }

  async function filterTools(ctx: TurnContext, request: ModelRequest): Promise<ModelRequest> {
    const tools = request.tools;
    if (tools === undefined || tools.length === 0) return request;

    // Include model request metadata so filtering uses the same policy
    // inputs as execution-time wrapToolCall (prevents visibility/auth mismatch)
    const queries = tools.map((t) => queryForTool(ctx, t.name, request.metadata));
    const decisions = await resolveBatch(queries, ctx.session.sessionId as string);

    const sessionTracker = getTracker(ctx.session.sessionId as string);

    const filtered = tools.filter((tool, i) => {
      // biome-ignore lint/style/noNonNullAssertion: decisions.length === tools.length (resolveBatch returns same length)
      const decision = decisions[i]!;
      if (auditSink !== undefined) {
        auditFilterDecision(ctx, tool.name, decision, auditSink);
      }
      // biome-ignore lint/style/noNonNullAssertion: queries built from tools.map — same length as filter callback index
      void ctx.dispatchPermissionDecision?.(queries[i]!, decision);
      if (decision.effect === "deny") {
        sessionTracker.record({
          toolId: tool.name,
          reason: decision.reason,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          source: denialSource(decision),
          // biome-ignore lint/style/noNonNullAssertion: queries built from tools.map — same length as filter callback index
          queryKey: decisionCacheKey(queries[i]!),
        });
        return false;
      }
      return true;
    });

    const filteredCount = tools.length - filtered.length;
    if (filteredCount > 0) {
      const filteredDetails = tools
        .map((t, i) => ({ name: t.name, decision: decisions[i] }))
        .filter(
          (
            d,
          ): d is {
            readonly name: string;
            readonly decision: { readonly effect: "deny"; readonly reason: string };
          } => d.decision?.effect === "deny",
        )
        .map((d) => ({
          tool: d.name,
          reason: d.decision.reason,
          source: denialSource(d.decision),
        }));
      ctx.reportDecision?.({
        phase: "filter",
        totalTools: tools.length,
        allowedCount: filtered.length,
        filteredCount,
        filteredTools: filteredDetails,
      });
    } else {
      ctx.reportDecision?.({
        phase: "filter",
        totalTools: tools.length,
        allowedCount: tools.length,
        filteredCount: 0,
      });
    }
    if (filtered.length === tools.length) return request;
    return { ...request, tools: filtered };
  }

  // -----------------------------------------------------------------------
  // Middleware + Handle
  // -----------------------------------------------------------------------

  function clearSessionApprovals(sessionId: string): void {
    // Mirror the cleanup performed by onSessionEnd, but callable externally
    // so the TUI runtime can clear per-session state on agent:clear / session:new
    // without disposing the runtime (which would call onSessionEnd internally).
    const sid = sessionId;
    trackersBySession.get(sid)?.clear();
    trackersBySession.delete(sid);
    decisionCachesBySession.get(sid)?.clear();
    decisionCachesBySession.delete(sid);
    approvalCachesBySession.get(sid)?.clear();
    approvalCachesBySession.delete(sid);
    alwaysAllowedBySession.delete(sid);
    // Evict all in-flight approval coalesce entries for this session so that
    // a stale dialog approval resolved after reset cannot re-populate the cache
    // or cause new callers to coalesce onto an old pending promise.
    // Note: the underlying approvalHandler promise itself is not cancellable here
    // (that requires disposing the permissionBridge), but removing the dedup entry
    // prevents any new callers from inheriting the stale approval decision.
    const keys = inflightKeysBySession.get(sid);
    if (keys !== undefined) {
      for (const key of keys) {
        inflightApprovals.delete(key);
      }
      inflightKeysBySession.delete(sid);
    }
  }

  const middleware: KoiMiddleware = {
    name: "permissions",
    priority: 100,
    phase: "intercept",

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return {
        label: "permissions",
        description: description ?? "Permission checks enabled",
      };
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      // Clear only this session's state — not other active sessions.
      // Backend is NOT disposed here: it is shared across sessions and
      // owned by the middleware instance, not by any individual session.
      const sid = ctx.sessionId as string;
      trackersBySession.get(sid)?.clear();
      trackersBySession.delete(sid);
      decisionCachesBySession.get(sid)?.clear();
      decisionCachesBySession.delete(sid);
      approvalCachesBySession.get(sid)?.clear();
      approvalCachesBySession.delete(sid);
      alwaysAllowedBySession.delete(sid);
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const filtered = await filterTools(ctx, request);
      return next(filtered);
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<never> {
      const filtered = await filterTools(ctx, request);
      yield* next(filtered) as AsyncIterable<never>;
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      // Backend policy queries see the FULL request.metadata — including
      // any callId — so custom backends keep their existing
      // _request.callId visibility. The stripped form is reserved for
      // approval cache + in-flight dedup keys, where per-invocation
      // entropy would defeat coalescing. (#1759 review round 5)
      const cacheMeta = policyMetadataOf(request.metadata);
      const query = queryForTool(ctx, request.toolId, request.metadata);
      const startMs = clock();
      const decision = await resolveDecision(query, ctx.session.sessionId as string);
      const durationMs = clock() - startMs;

      if (auditSink !== undefined) {
        auditDecision(ctx, request.toolId, decision, durationMs, auditSink);
      }
      void ctx.dispatchPermissionDecision?.(query, decision);

      // Report the permission decision for trace recording
      ctx.reportDecision?.({
        phase: "execute",
        toolId: request.toolId,
        toolInput: safePreviewJson(request.input, 300),
        action: decision.effect,
        durationMs,
        ...(decision.effect !== "allow" ? { reason: decision.reason } : {}),
        source: denialSource(decision),
      });

      if (decision.effect === "deny") {
        getTracker(ctx.session.sessionId as string).record({
          toolId: request.toolId,
          reason: decision.reason,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          source: denialSource(decision),
          queryKey: decisionCacheKey(query),
        });

        throw new KoiRuntimeError({
          code: "PERMISSION",
          message: decision.reason,
          retryable: false,
        });
      }

      if (decision.effect === "ask") {
        // Pass a dispatch callback so each approval path fires the outcome
        // BEFORE calling next(request) — ensures recording even if the tool throws.
        return handleAskDecision(ctx, request, next, decision, (d) => {
          void ctx.dispatchPermissionDecision?.(query, d);
        });
      }

      // allow
      return next(request);
    },
  };

  return Object.assign(middleware, {
    setApprovalStepSink(sink: (sessionId: string, step: RichTrajectoryStep) => void): () => void {
      runtimeSinks.push(sink);
      return () => {
        const idx = runtimeSinks.indexOf(sink);
        if (idx >= 0) runtimeSinks.splice(idx, 1);
      };
    },
    clearSessionApprovals,
    revokePersistentApproval(userId: string, agentId: string, toolId: string): boolean {
      if (persistentStore === undefined) return false;
      // Removes the durable row only. Active sessions retain their own
      // session-scoped bypass until session end — the in-memory set does not
      // encode user identity or grant source, so clearing it would break
      // unrelated session-only approvals. New sessions will prompt again.
      return persistentStore.revoke(userId, agentId, toolId);
    },
    revokeAllPersistentApprovals(): void {
      // Same rationale: only clear durable state. Session-scoped grants
      // remain until the session ends or clearSessionApprovals() is called.
      persistentStore?.revokeAll();
    },
    listPersistentApprovals(): readonly import("./approval-store.js").ApprovalGrant[] {
      if (persistentStore === undefined) return [];
      return persistentStore.list();
    },
  }) as PermissionsMiddlewareHandle;

  // -----------------------------------------------------------------------
  // Ask / approval flow
  // -----------------------------------------------------------------------

  async function handleAskDecision(
    ctx: TurnContext,
    request: ToolRequest,
    next: ToolHandler,
    decision: PermissionDecision & { readonly effect: "ask" },
    dispatchApprovalOutcome?: (d: PermissionDecision) => void,
  ): Promise<ToolResponse> {
    // Strip ephemeral fields (callId) from metadata for cache / dedup key
    // construction. The full unmodified metadata still flows into the
    // backend policy query upstream — see policyMetadataOf doc and #1759
    // review round 5.
    const cacheMeta = policyMetadataOf(request.metadata);
    const approvalHandler: ApprovalHandler | undefined = ctx.requestApproval;

    if (approvalHandler === undefined) {
      throw new KoiRuntimeError({
        code: "PERMISSION",
        message: `Tool "${request.toolId}" requires approval but no approval handler is configured`,
        retryable: false,
      });
    }

    // Check persistent always-allow grants (cross-session, SQLite-backed).
    // Fail-open: if the store throws (corrupt DB, lock contention), fall through
    // to the session check and ultimately to the user prompt. This is fail-safe —
    // a broken store means more prompts, not silent denials or silent allows.
    // Persistent grants require a real user identity — anonymous sessions
    // must not share a durable principal, so we skip the store entirely.
    // Use persistentAgentId if configured (stable across restarts) — falls back
    // to the per-process agentId for multi-agent runtimes.
    const persistentUserId = ctx.session.userId;
    const persistentAid = persistentAgentId ?? ctx.session.agentId;
    if (persistentStore !== undefined && persistentUserId !== undefined) {
      try {
        if (persistentStore.has(persistentUserId, persistentAid, request.toolId)) {
          const persistentStartMs = clock();
          getTracker(ctx.session.sessionId as string).record({
            toolId: request.toolId,
            reason: `auto-approved (persistent always-allow grant, agent: ${ctx.session.agentId})`,
            timestamp: persistentStartMs,
            principal: ctx.session.agentId,
            turnIndex: ctx.turnIndex,
            source: "approval",
          });
          emitApprovalStep(
            ctx,
            request.toolId,
            { kind: "always-allow", scope: "always" },
            request.input,
            persistentStartMs,
          );
          if (auditSink !== undefined) {
            auditApprovalOutcome(
              ctx,
              request.toolId,
              { kind: "always-allow", scope: "always" },
              request.input,
              clock() - persistentStartMs,
              auditSink,
              /* coalesced */ false,
              /* remembered */ true,
            );
          }
          // Dispatch before next() so the permission outcome is recorded even if the tool throws
          dispatchApprovalOutcome?.({ effect: "allow" });
          return next(request);
        }
      } catch {
        // Fall through to session/cache/prompt — fail-open.
      }
    }

    // Check always-allowed set (from prior "always-allow" decisions).
    // This is a per-tool session bypass — intentionally matches Claude Code's "a" key
    // behavior where pressing "a" approves ALL future calls to that tool in the session.
    // The user explicitly opted in by choosing "always-allow" over single "allow".
    // Keyed by agentId+toolId so child/sub-agents cannot inherit a parent's approval.
    const alwaysAllowKey = `${ctx.session.agentId}\0${request.toolId}`;
    const sessionAlwaysAllowed = alwaysAllowedBySession.get(ctx.session.sessionId as string);
    if (sessionAlwaysAllowed?.has(alwaysAllowKey)) {
      const alwaysAllowStartMs = clock();
      getTracker(ctx.session.sessionId as string).record({
        toolId: request.toolId,
        reason: `auto-approved (always-allow session rule, agent: ${ctx.session.agentId})`,
        timestamp: alwaysAllowStartMs,
        principal: ctx.session.agentId,
        turnIndex: ctx.turnIndex,
        source: "approval",
      });
      emitApprovalStep(
        ctx,
        request.toolId,
        { kind: "always-allow", scope: "session" },
        request.input,
        alwaysAllowStartMs,
      );
      // Dispatch before next() so the permission outcome is recorded even if the tool throws
      dispatchApprovalOutcome?.({ effect: "allow" });
      return next(request);
    }

    // Check approval cache (per-session)
    const approvalCache = getApprovalCache(ctx.session.sessionId as string);
    if (approvalCache !== undefined) {
      const userId = ctx.session.userId ?? "__anonymous__";
      const ctxStr = serializeTurnContext(ctx);
      const cacheKey = computeApprovalCacheKey(
        backendFingerprint,
        ctx.session.sessionId as string,
        userId,
        ctx.session.agentId,
        request.toolId,
        request.input,
        ctxStr,
        cacheMeta,
        decision.reason,
      );

      if (cacheKey !== undefined && approvalCache.has(cacheKey)) {
        emitApprovalStep(ctx, request.toolId, { kind: "allow" }, request.input, clock());
        // Dispatch before next() so the permission outcome is recorded even if the tool throws
        dispatchApprovalOutcome?.({ effect: "allow" });
        return next(request);
      }
    }

    // Build dedup key for in-flight coordination
    const dedupUserId = ctx.session.userId ?? "__anonymous__";
    const dedupCtx = serializeTurnContext(ctx);
    const dedupKey = computeApprovalCacheKey(
      backendFingerprint,
      ctx.session.sessionId as string,
      dedupUserId,
      ctx.session.agentId,
      request.toolId,
      request.input,
      dedupCtx,
      cacheMeta,
      decision.reason,
    );

    // Coalesce concurrent identical asks onto a single pending approval
    if (dedupKey !== undefined) {
      const inflight = inflightApprovals.get(dedupKey);
      if (inflight !== undefined) {
        // Another call is already waiting for approval — wait for its result
        const coalescedStartMs = clock();
        // let: rawResult is assigned in try, used after
        let rawResult: unknown;
        try {
          rawResult = await inflight;
        } catch (e: unknown) {
          // Leader timed out or handler threw — emit failure step for this follower
          const reason =
            e instanceof KoiRuntimeError && e.code === "TIMEOUT" ? "timeout" : "handler_error";
          emitApprovalStep(
            ctx,
            request.toolId,
            { kind: "deny", reason },
            request.input,
            coalescedStartMs,
            true,
          );
          if (e instanceof KoiRuntimeError) throw e;
          throw new KoiRuntimeError({
            code: "INTERNAL",
            message: `Coalesced approval error for "${request.toolId}"`,
            retryable: false,
            cause: e,
          });
        }
        const result = validateApprovalDecision(rawResult);

        // Emit approval-outcome audit + trajectory for this coalesced caller.
        // Marked coalesced: true so downstream systems know this reused an existing
        // human decision rather than prompting a new one.
        const coalescedDurationMs = clock() - coalescedStartMs;
        if (result !== undefined && auditSink !== undefined) {
          auditApprovalOutcome(
            ctx,
            request.toolId,
            result,
            request.input,
            coalescedDurationMs,
            auditSink,
            true,
          );
        }
        if (result !== undefined) {
          emitApprovalStep(ctx, request.toolId, result, request.input, coalescedStartMs, true);
        } else {
          // Malformed coalesced response — emit failure step so it's observable
          emitApprovalStep(
            ctx,
            request.toolId,
            { kind: "deny", reason: "malformed_response" },
            request.input,
            coalescedStartMs,
            true,
          );
        }

        if (result === undefined || result.kind === "deny") {
          dispatchApprovalOutcome?.({
            effect: "deny",
            reason: `Tool "${request.toolId}" denied (coalesced approval)`,
          });
          throw new KoiRuntimeError({
            code: "PERMISSION",
            message: `Tool "${request.toolId}" denied (coalesced approval)`,
            retryable: false,
          });
        }
        // Dispatch allow before next() so outcome is recorded even if the tool throws
        dispatchApprovalOutcome?.({ effect: "allow" });
        if (result.kind === "modify") {
          return next({ ...request, input: result.updatedInput });
        }
        return next(request);
      }
    }

    // Request approval with timeout
    const approvalStartMs = clock();
    const ac = new AbortController();

    // When approvalTimeoutMs is Infinity (default, see #1759), the timeout
    // leg is omitted entirely — users get unbounded time to respond to
    // interactive permission prompts. Agent-to-agent callers that need a
    // hung-handler backstop should pass a finite value explicitly.
    const approvalRace: readonly Promise<unknown>[] = [
      approvalHandler({
        toolId: request.toolId,
        input: request.input,
        reason: decision.reason,
        ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
      }),
      ...(Number.isFinite(approvalTimeoutMs)
        ? [
            new Promise<never>((_, reject) => {
              const timerId = setTimeout(() => {
                reject(
                  new KoiRuntimeError({
                    code: "TIMEOUT",
                    message: `Approval for "${request.toolId}" timed out after ${approvalTimeoutMs}ms`,
                    retryable: false,
                  }),
                );
              }, approvalTimeoutMs);
              ac.signal.addEventListener("abort", () => clearTimeout(timerId), { once: true });
            }),
          ]
        : []),
      // Race against the turn/session abort signal so an aborted turn
      // (Ctrl+C / agent:clear) cannot win approval and execute the tool
      // in what the user now believes is a fresh session.
      ...(ctx.signal !== undefined
        ? (() => {
            // Capture signal before the Promise closure so TypeScript narrows it
            // to AbortSignal (not AbortSignal | undefined) inside the callback.
            const turnSignal = ctx.signal;
            return [
              new Promise<never>((_, reject) => {
                if (turnSignal.aborted) {
                  reject(
                    new KoiRuntimeError({
                      code: "PERMISSION",
                      message: `Approval for "${request.toolId}" cancelled: turn was aborted`,
                      retryable: false,
                    }),
                  );
                  return;
                }
                turnSignal.addEventListener(
                  "abort",
                  () =>
                    reject(
                      new KoiRuntimeError({
                        code: "PERMISSION",
                        message: `Approval for "${request.toolId}" cancelled: turn was aborted`,
                        retryable: false,
                      }),
                    ),
                  { once: true },
                );
              }),
            ];
          })()
        : []),
    ];

    const approvalPromise = Promise.race(approvalRace).finally(() => {
      ac.abort();
      if (dedupKey !== undefined) {
        inflightApprovals.delete(dedupKey);
        // Also remove from per-session index
        inflightKeysBySession.get(ctx.session.sessionId as string)?.delete(dedupKey);
      }
    });

    // Register in-flight so concurrent callers coalesce
    if (dedupKey !== undefined) {
      inflightApprovals.set(dedupKey, approvalPromise);
      // Track under session so clearSessionApprovals can evict on reset
      const sid = ctx.session.sessionId as string;
      let keys = inflightKeysBySession.get(sid);
      if (keys === undefined) {
        keys = new Set();
        inflightKeysBySession.set(sid, keys);
      }
      keys.add(dedupKey);
    }

    // let: tracks whether an approval step was already emitted in the try block
    let stepEmitted = false;
    try {
      const rawResult = await approvalPromise;

      // Validate approval response at trust boundary — fail closed on malformed
      const approvalResult = validateApprovalDecision(rawResult);
      if (approvalResult === undefined) {
        emitApprovalStep(
          ctx,
          request.toolId,
          { kind: "deny", reason: "malformed_response" },
          request.input,
          approvalStartMs,
        );
        stepEmitted = true;
        dispatchApprovalOutcome?.({ effect: "deny", reason: "malformed_response" });
        throw new KoiRuntimeError({
          code: "PERMISSION",
          message: `Malformed approval response for "${request.toolId}" — failing closed`,
          retryable: false,
        });
      }

      // Emit second audit entry and trajectory step for the approval outcome
      const approvalDurationMs = clock() - approvalStartMs;
      if (auditSink !== undefined) {
        auditApprovalOutcome(
          ctx,
          request.toolId,
          approvalResult,
          request.input,
          approvalDurationMs,
          auditSink,
        );
      }
      emitApprovalStep(ctx, request.toolId, approvalResult, request.input, approvalStartMs);
      stepEmitted = true;

      if (approvalResult.kind === "deny") {
        getTracker(ctx.session.sessionId as string).record({
          toolId: request.toolId,
          reason: approvalResult.reason,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          source: "approval",
        });

        dispatchApprovalOutcome?.({ effect: "deny", reason: approvalResult.reason });
        throw new KoiRuntimeError({
          code: "PERMISSION",
          message: `Tool "${request.toolId}" denied by approval handler: ${approvalResult.reason}`,
          retryable: false,
        });
      }

      // Handle "always-allow" — add tool to session's always-allowed set.
      // Keyed by agentId+toolId so sub-agents cannot inherit a parent's approval.
      // For scope "always", also persist to durable storage (SQLite).
      if (approvalResult.kind === "always-allow") {
        const sid = ctx.session.sessionId as string;
        let allowed = alwaysAllowedBySession.get(sid);
        if (allowed === undefined) {
          allowed = new Set();
          alwaysAllowedBySession.set(sid, allowed);
        }
        const grantKey = `${ctx.session.agentId}\0${request.toolId}`;
        allowed.add(grantKey);

        // Persist to durable storage if scope is "always", store is configured,
        // and a real user identity exists. Anonymous sessions cannot create durable
        // grants — they silently downgrade to session scope.
        // Fail-safe: if persist throws, the tool still executes (approval was given)
        // but permanence is not recorded. The user gets re-prompted next session.
        const grantUserId = ctx.session.userId;
        const grantAgentId = persistentAgentId ?? ctx.session.agentId;
        if (
          approvalResult.scope === "always" &&
          persistentStore !== undefined &&
          grantUserId !== undefined
        ) {
          try {
            persistentStore.grant(grantUserId, grantAgentId, request.toolId, clock());
          } catch {
            // Approval was given — execute the tool. Permanence just wasn't recorded.
          }
        }

        getTracker(sid).record({
          toolId: request.toolId,
          reason: `always-allow granted (scope: ${approvalResult.scope})`,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          source: "approval",
        });

        // Dispatch before next() so the permission outcome is recorded even if the tool throws
        dispatchApprovalOutcome?.({ effect: "allow" });
        return next(request);
      }

      // Handle "modify" — use updated input
      // Never cache modify results: the input rewrite is the safety mechanism,
      // and caching would replay the original unsafe input on subsequent calls
      if (approvalResult.kind === "modify") {
        // Dispatch before next() so the permission outcome is recorded even if the tool throws
        dispatchApprovalOutcome?.({ effect: "allow" });
        return next({ ...request, input: approvalResult.updatedInput });
      }

      // Cache allow-only approvals (never modify — see above)
      if (approvalCache !== undefined) {
        const userId = ctx.session.userId ?? "__anonymous__";
        const ctxStr = serializeTurnContext(ctx);
        const cacheKey = computeApprovalCacheKey(
          backendFingerprint,
          ctx.session.sessionId as string,
          userId,
          ctx.session.agentId,
          request.toolId,
          request.input,
          ctxStr,
          cacheMeta,
          decision.reason,
        );
        if (cacheKey !== undefined) approvalCache.set(cacheKey);
      }

      // "allow" — dispatch before next() so outcome is recorded even if the tool throws
      dispatchApprovalOutcome?.({ effect: "allow" });
      return next(request);
    } catch (e: unknown) {
      // Emit a failure trajectory step for timeout/handler errors so they
      // are observable in ATIF even though no valid decision was received.
      // Skip if a step was already emitted (e.g., a deny that throws after emitting).
      if (!stepEmitted) {
        const reason =
          e instanceof KoiRuntimeError && e.code === "TIMEOUT" ? "timeout" : "handler_error";
        emitApprovalStep(
          ctx,
          request.toolId,
          { kind: "deny", reason },
          request.input,
          approvalStartMs,
        );
      }
      if (e instanceof KoiRuntimeError) throw e;
      throw new KoiRuntimeError({
        code: "INTERNAL",
        message: `Approval handler error for "${request.toolId}"`,
        retryable: false,
        cause: e,
      });
    }
  }
}
