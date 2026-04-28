/**
 * Internal cache factories and decision helpers for the permissions middleware.
 *
 * Pure helpers with no closure dependencies — they only depend on types from
 * @koi/core and @koi/errors.
 */

import type { PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";
import type { ApprovalCacheConfig, PermissionCacheConfig } from "./config.js";
import {
  DEFAULT_APPROVAL_CACHE_MAX_ENTRIES,
  DEFAULT_APPROVAL_CACHE_TTL_MS,
  DEFAULT_CACHE_CONFIG,
} from "./config.js";

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

export function createDecisionCache(
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

export function createApprovalCache(
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

export const VALID_EFFECTS: Set<string> = new Set(["allow", "deny", "ask"]);

/** Symbol to tag fail-closed denials so escalation can exclude them. */
export const IS_FAIL_CLOSED: unique symbol = Symbol.for("@koi/middleware-permissions/fail-closed");

export const FAIL_CLOSED_DENY: PermissionDecision = Object.freeze({
  effect: "deny",
  reason: "Malformed backend decision — failing closed",
  [IS_FAIL_CLOSED]: true,
} as PermissionDecision);

export function isFailClosed(decision: PermissionDecision): boolean {
  return (decision as Record<symbol, unknown>)[IS_FAIL_CLOSED] === true;
}

export function failClosedDeny(reason: string): PermissionDecision {
  return Object.freeze({
    effect: "deny",
    reason,
    [IS_FAIL_CLOSED]: true,
  } as PermissionDecision);
}

/** Symbol to tag escalation-generated denials so they don't self-sustain. */
export const IS_ESCALATED: unique symbol = Symbol.for("@koi/middleware-permissions/escalated");

export function isEscalated(decision: PermissionDecision): boolean {
  return (decision as Record<symbol, unknown>)[IS_ESCALATED] === true;
}

/** Symbol to tag cached deny replays so they don't inflate escalation counts. */
export const IS_CACHED: unique symbol = Symbol.for("@koi/middleware-permissions/cached");

export function isCached(decision: PermissionDecision): boolean {
  return (decision as Record<symbol, unknown>)[IS_CACHED] === true;
}

export function tagCached(decision: PermissionDecision): PermissionDecision {
  if (decision.effect !== "deny") return decision;
  return { ...decision, [IS_CACHED]: true } as PermissionDecision;
}

/** Safely serialize a value to a JSON preview string, truncated to maxLen. */
export function safePreviewJson(value: unknown, maxLen: number): string {
  try {
    const s = JSON.stringify(value);
    return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
  } catch {
    return "[unserializable]";
  }
}

/** Determine denial source for tracker recording. Only "policy" counts toward escalation. */
export function denialSource(
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
export function validateDecision(raw: unknown): PermissionDecision {
  if (raw === null || typeof raw !== "object") return FAIL_CLOSED_DENY;
  const obj = raw as Record<string, unknown>;
  if (!VALID_EFFECTS.has(obj.effect as string)) return FAIL_CLOSED_DENY;
  if (obj.effect === "deny" || obj.effect === "ask") {
    if (typeof obj.reason !== "string") return FAIL_CLOSED_DENY;
  }
  return raw as PermissionDecision;
}

export const VALID_APPROVAL_KINDS: Set<string> = new Set([
  "allow",
  "always-allow",
  "deny",
  "modify",
]);
export const VALID_ALWAYS_ALLOW_SCOPES: Set<string> = new Set(["session", "always"]);

/**
 * Validate an approval handler response at the trust boundary.
 * Returns the validated decision or undefined if malformed (caller
 * should fail closed).
 */
export function validateApprovalDecision(
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
export function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Full serialized key — collision-safe for security-sensitive cache lookups. */
export function decisionCacheKey(query: PermissionQuery): string | undefined {
  const ctx = query.context !== undefined ? safeStringify(query.context) : "";
  if (ctx === undefined) return undefined;
  return `${query.principal}\0${query.action}\0${query.resource}\0${ctx}`;
}

export function safeSerializeInput(value: unknown): string | undefined {
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

/** Full serialized key — collision-safe for approval cache lookups. */
export function computeApprovalCacheKey(
  backendFingerprint: string,
  sessionId: string,
  userId: string,
  agentId: string,
  toolId: string,
  input: unknown,
  context: string | undefined,
  requestMeta: unknown,
  approvalReason: string,
  // For bash-like tools, includes the derived bash grant key so a
  // cached one-off allow in one execution context cannot replay in
  // another. For non-bash tools, `grantKey === toolId` and this has
  // no effect on cache key identity.
  grantKey: string,
): string | undefined {
  if (context === undefined) return undefined;
  const sorted = safeSerializeInput(input);
  if (sorted === undefined) return undefined;
  const reqMeta = requestMeta !== undefined ? safeStringify(requestMeta) : "";
  if (reqMeta === undefined) return undefined;
  return `${backendFingerprint}\0${sessionId}\0${userId}\0${agentId}\0${toolId}\0${grantKey}\0${sorted}\0${context}\0${reqMeta}\0${approvalReason}`;
}

/** Serialize turn-scoped context for inclusion in approval cache keys. */
/** Returns undefined when metadata is not serializable — caller must skip caching. */
export function serializeTurnContext(ctx: {
  readonly session: { readonly metadata: Record<string, unknown> };
  readonly metadata: Record<string, unknown>;
}): string | undefined {
  const sessionMeta = ctx.session.metadata;
  const turnMeta = ctx.metadata;
  const hasSession = Object.keys(sessionMeta).length > 0;
  const hasTurn = Object.keys(turnMeta).length > 0;
  if (!hasSession && !hasTurn) return "";
  const combined = { ...(hasSession ? { _s: sessionMeta } : {}), ...(hasTurn ? turnMeta : {}) };
  return safeStringify(combined);
}

/**
 * Build an unambiguous principal string from structured identity fields.
 * Uses JSON array encoding to prevent separator collisions — e.g. an
 * agentId containing ":" cannot produce the same principal as a
 * different agent/user/session tuple.
 */
export function buildPrincipal(agentId: string, userId: string, sessionId: string): string {
  return JSON.stringify([agentId, userId, sessionId]);
}
