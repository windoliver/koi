/**
 * resolveDecision and resolveBatch factory for the permissions middleware.
 *
 * Extracted from middleware.ts to keep file sizes under 800 lines.
 * Accepts all closure dependencies as explicit factory parameters.
 */

import type {
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
} from "@koi/core/permission-backend";
import type { CircuitBreaker } from "@koi/errors";
import type { DenialTracker } from "./denial-tracker.js";
import {
  FAIL_CLOSED_DENY,
  failClosedDeny,
  IS_ESCALATED,
  tagCached,
  validateDecision,
} from "./middleware-internals.js";

export interface BatchResolverDeps {
  readonly backend: PermissionBackend;
  readonly cb: CircuitBreaker | undefined;
  readonly getDecisionCache: (sessionId: string) =>
    | {
        readonly get: (key: string) => PermissionDecision | undefined;
        readonly set: (key: string, decision: PermissionDecision) => void;
        readonly clear: () => void;
      }
    | undefined;
  readonly escalationEnabled: boolean;
  readonly escalationThreshold: number;
  readonly escalationWindowMs: number;
  readonly clock: () => number;
  readonly getTracker: (sessionId: string) => DenialTracker;
  readonly decisionCacheKey: (q: PermissionQuery) => string | undefined;
}

export function createBatchResolver(deps: BatchResolverDeps): {
  readonly resolveDecision: (
    query: PermissionQuery,
    sessionId: string,
  ) => Promise<PermissionDecision>;
  readonly resolveBatch: (
    queries: readonly PermissionQuery[],
    sessionId: string,
  ) => Promise<readonly PermissionDecision[]>;
} {
  const {
    backend,
    cb,
    getDecisionCache,
    escalationEnabled,
    escalationThreshold,
    escalationWindowMs,
    clock,
    getTracker,
    decisionCacheKey,
  } = deps;

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
              r.softness !== "soft" &&
              r.origin !== "soft-conversion" &&
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
              r.softness !== "soft" &&
              r.origin !== "soft-conversion" &&
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

  return { resolveDecision, resolveBatch };
}
