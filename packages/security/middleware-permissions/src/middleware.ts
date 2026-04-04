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
const VALID_ALWAYS_ALLOW_SCOPES = new Set(["session"]);

/**
 * Validate an approval handler response at the trust boundary.
 * Returns the validated decision or undefined if malformed (caller
 * should fail closed).
 */
function validateApprovalDecision(
  raw: unknown,
):
  | { readonly kind: "allow" }
  | { readonly kind: "always-allow"; readonly scope: "session" }
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
    return { kind: "always-allow", scope: scope as "session" };
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

export function createPermissionsMiddleware(config: PermissionsMiddlewareConfig): KoiMiddleware {
  const { backend, auditSink, description, onApprovalStep } = config;
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
      timestamp: clock(),
      sessionId: ctx.session.sessionId as string,
      agentId: ctx.session.agentId,
      turnIndex: ctx.turnIndex,
      kind: "tool_call",
      durationMs,
      metadata: {
        permissionCheck: true,
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
    | { readonly kind: "always-allow"; readonly scope: "session" }
    | { readonly kind: "deny"; readonly reason: string }
    | { readonly kind: "modify"; readonly updatedInput: Record<string, unknown> };

  /** Audit an approval outcome after the human responds. */
  function auditApprovalOutcome(
    ctx: TurnContext,
    resource: string,
    approval: ValidatedApproval,
    originalInput: JsonObject,
    durationMs: number,
    sink: AuditSink,
  ): void {
    const meta: Record<string, unknown> = {
      permissionCheck: true,
      phase: "approval_outcome",
      resource,
      approvalDecision: approval.kind,
      userId: ctx.session.userId ?? "__anonymous__",
    };
    if (approval.kind === "deny") {
      meta.denyReason = approval.reason;
    }
    if (approval.kind === "modify") {
      meta.originalInput = originalInput;
      meta.modifiedInput = approval.updatedInput;
    }
    if (approval.kind === "always-allow") {
      meta.scope = approval.scope;
    }
    const entry: AuditEntry = {
      timestamp: clock(),
      sessionId: ctx.session.sessionId as string,
      agentId: ctx.session.agentId,
      turnIndex: ctx.turnIndex,
      kind: "tool_call",
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
  ): void {
    if (onApprovalStep === undefined) return;
    const meta: Record<string, unknown> = {
      approvalDecision: approval.kind,
      userId: ctx.session.userId ?? "__anonymous__",
    };
    if (approval.kind === "modify") {
      meta.modifiedInput = approval.updatedInput;
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
      request: { data: originalInput },
      metadata: meta as JsonObject,
    };
    onApprovalStep(ctx.session.sessionId as string, step);
  }

  /** Audit a permission decision at model-time filtering (wrapModelCall). */
  function auditFilterDecision(
    ctx: TurnContext,
    resource: string,
    decision: PermissionDecision,
    sink: AuditSink,
  ): void {
    const entry: AuditEntry = {
      timestamp: clock(),
      sessionId: ctx.session.sessionId as string,
      agentId: ctx.session.agentId,
      turnIndex: ctx.turnIndex,
      kind: "model_call",
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
        const query = queries[i]!;
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
        const query = queries[i]!;
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
          const idx = uncachedIndices[j]!;
          const decision = validated[j]!;
          results[idx] = decision;
          if (decisionCache !== undefined) {
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
      const decision = decisions[i]!;
      if (auditSink !== undefined) {
        auditFilterDecision(ctx, tool.name, decision, auditSink);
      }
      if (decision.effect === "deny") {
        sessionTracker.record({
          toolId: tool.name,
          reason: decision.reason,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          source: denialSource(decision),
          queryKey: decisionCacheKey(queries[i]!),
        });
        return false;
      }
      return true;
    });

    if (filtered.length === tools.length) return request;
    return { ...request, tools: filtered };
  }

  // -----------------------------------------------------------------------
  // Middleware
  // -----------------------------------------------------------------------

  return {
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
      const query = queryForTool(ctx, request.toolId, request.metadata);
      const startMs = clock();
      const decision = await resolveDecision(query, ctx.session.sessionId as string);
      const durationMs = clock() - startMs;

      if (auditSink !== undefined) {
        auditDecision(ctx, request.toolId, decision, durationMs, auditSink);
      }

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
        return handleAskDecision(ctx, request, next, decision);
      }

      // allow
      return next(request);
    },
  };

  // -----------------------------------------------------------------------
  // Ask / approval flow
  // -----------------------------------------------------------------------

  async function handleAskDecision(
    ctx: TurnContext,
    request: ToolRequest,
    next: ToolHandler,
    decision: PermissionDecision & { readonly effect: "ask" },
  ): Promise<ToolResponse> {
    const approvalHandler: ApprovalHandler | undefined = ctx.requestApproval;

    if (approvalHandler === undefined) {
      throw new KoiRuntimeError({
        code: "PERMISSION",
        message: `Tool "${request.toolId}" requires approval but no approval handler is configured`,
        retryable: false,
      });
    }

    // Check always-allowed set (from prior "always-allow" decisions).
    // This is a per-tool session bypass — intentionally matches Claude Code's "a" key
    // behavior where pressing "a" approves ALL future calls to that tool in the session.
    // The user explicitly opted in by choosing "always-allow" over single "allow".
    // Keyed by agentId+toolId so child/sub-agents cannot inherit a parent's approval.
    const alwaysAllowKey = `${ctx.session.agentId}\0${request.toolId}`;
    const sessionAlwaysAllowed = alwaysAllowedBySession.get(ctx.session.sessionId as string);
    if (sessionAlwaysAllowed?.has(alwaysAllowKey)) {
      getTracker(ctx.session.sessionId as string).record({
        toolId: request.toolId,
        reason: `auto-approved (always-allow session rule, agent: ${ctx.session.agentId})`,
        timestamp: clock(),
        principal: ctx.session.agentId,
        turnIndex: ctx.turnIndex,
        source: "approval",
      });
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
        request.metadata,
        decision.reason,
      );

      if (cacheKey !== undefined && approvalCache.has(cacheKey)) {
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
      request.metadata,
      decision.reason,
    );

    // Coalesce concurrent identical asks onto a single pending approval
    if (dedupKey !== undefined) {
      const inflight = inflightApprovals.get(dedupKey);
      if (inflight !== undefined) {
        // Another call is already waiting for approval — wait for its result
        const rawResult = await inflight;
        const result = validateApprovalDecision(rawResult);
        if (result === undefined || result.kind === "deny") {
          throw new KoiRuntimeError({
            code: "PERMISSION",
            message: `Tool "${request.toolId}" denied (coalesced approval)`,
            retryable: false,
          });
        }
        if (result.kind === "modify") {
          return next({ ...request, input: result.updatedInput });
        }
        return next(request);
      }
    }

    // Request approval with timeout
    const approvalStartMs = clock();
    const ac = new AbortController();

    const approvalPromise = Promise.race([
      approvalHandler({
        toolId: request.toolId,
        input: request.input,
        reason: decision.reason,
        ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
      }),
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
    ]).finally(() => {
      ac.abort();
      if (dedupKey !== undefined) inflightApprovals.delete(dedupKey);
    });

    // Register in-flight so concurrent callers coalesce
    if (dedupKey !== undefined) {
      inflightApprovals.set(dedupKey, approvalPromise);
    }

    try {
      const rawResult = await approvalPromise;

      // Validate approval response at trust boundary — fail closed on malformed
      const approvalResult = validateApprovalDecision(rawResult);
      if (approvalResult === undefined) {
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

      if (approvalResult.kind === "deny") {
        getTracker(ctx.session.sessionId as string).record({
          toolId: request.toolId,
          reason: approvalResult.reason,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          source: "approval",
        });

        throw new KoiRuntimeError({
          code: "PERMISSION",
          message: `Tool "${request.toolId}" denied by approval handler: ${approvalResult.reason}`,
          retryable: false,
        });
      }

      // Handle "always-allow" — add tool to session's always-allowed set.
      // Only scope: "session" is supported. Cross-session persistence ("tool" scope)
      // was removed from the public API to avoid contract skew — it will be added
      // when durable storage is implemented.
      // Keyed by agentId+toolId so sub-agents cannot inherit a parent's approval.
      if (approvalResult.kind === "always-allow") {
        const sid = ctx.session.sessionId as string;
        let allowed = alwaysAllowedBySession.get(sid);
        if (allowed === undefined) {
          allowed = new Set();
          alwaysAllowedBySession.set(sid, allowed);
        }
        const grantKey = `${ctx.session.agentId}\0${request.toolId}`;
        allowed.add(grantKey);

        getTracker(sid).record({
          toolId: request.toolId,
          reason: `always-allow granted (scope: ${approvalResult.scope})`,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          source: "approval",
        });

        return next(request);
      }

      // Handle "modify" — use updated input
      // Never cache modify results: the input rewrite is the safety mechanism,
      // and caching would replay the original unsafe input on subsequent calls
      if (approvalResult.kind === "modify") {
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
          request.metadata,
          decision.reason,
        );
        if (cacheKey !== undefined) approvalCache.set(cacheKey);
      }

      // "allow"
      return next(request);
    } catch (e: unknown) {
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
