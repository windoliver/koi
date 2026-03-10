/**
 * Permissions middleware factory — tool-level access control + HITL approval.
 *
 * Uses PermissionBackend (L0) for pluggable authorization.
 * Filters denied tools from model calls (wrapModelCall) and re-checks at
 * tool invocation (wrapToolCall). Supports async backends, decision caching,
 * and fail-closed semantics.
 */

import type { AuditEntry } from "@koi/core";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";
import { createCircuitBreaker, KoiRuntimeError, swallowError } from "@koi/errors";
import type { PermissionCacheConfig, PermissionsMiddlewareConfig } from "./config.js";
import {
  DEFAULT_APPROVAL_CACHE_MAX_ENTRIES,
  DEFAULT_APPROVAL_CACHE_TTL_MS,
  DEFAULT_CACHE_CONFIG,
} from "./config.js";
import { fnv1a } from "./hash.js";

/** Entry in the approval (ask) cache — stores only the timestamp. */
interface ApprovalCacheEntry {
  readonly cachedAt: number;
}

/** Entry in the decision (allow/deny) cache. */
interface DecisionCacheEntry {
  readonly decision: PermissionDecision;
  readonly expiresAt: number;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

function createDecisionCache(
  config: PermissionCacheConfig,
  clock: () => number,
): {
  readonly get: (key: number) => PermissionDecision | undefined;
  readonly set: (key: number, decision: PermissionDecision) => void;
} {
  const maxEntries = config.maxEntries ?? DEFAULT_CACHE_CONFIG.maxEntries;
  const allowTtlMs = config.allowTtlMs ?? DEFAULT_CACHE_CONFIG.allowTtlMs;
  const denyTtlMs = config.denyTtlMs ?? DEFAULT_CACHE_CONFIG.denyTtlMs;
  const store = new Map<number, DecisionCacheEntry>();

  return {
    get(key) {
      const entry = store.get(key);
      if (entry === undefined) return undefined;
      if (clock() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      // LRU refresh: delete+reinsert to move to end of iteration order
      store.delete(key);
      store.set(key, entry);
      return entry.decision;
    },
    set(key, decision) {
      // Don't cache "ask" decisions — they require user interaction each time
      if (decision.effect === "ask") return;
      const ttl = decision.effect === "allow" ? allowTtlMs : denyTtlMs;
      if (store.size >= maxEntries) {
        // LRU eviction: first key in Map is oldest
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(key, { decision, expiresAt: clock() + ttl });
    },
  };
}

export function createPermissionsMiddleware(config: PermissionsMiddlewareConfig): KoiMiddleware {
  const {
    backend,
    approvalHandler,
    approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    clock = Date.now,
    auditSink,
  } = config;

  // Resolve decision cache config (for allow/deny decisions from backend)
  const cacheConfig: PermissionCacheConfig | false =
    config.cache === true
      ? { ...DEFAULT_CACHE_CONFIG }
      : config.cache === false || config.cache === undefined
        ? false
        : config.cache;

  const cache = cacheConfig !== false ? createDecisionCache(cacheConfig, clock) : undefined;

  const cb = config.circuitBreaker ? createCircuitBreaker(config.circuitBreaker, clock) : undefined;

  // Approval cache: stores human "ask" approvals keyed by policy + identity + tool + input.
  // The approval cache is enabled when the decision cache is enabled (same config toggle).
  const approvalCacheTtlMs =
    cacheConfig !== false ? (cacheConfig.ttlMs ?? DEFAULT_APPROVAL_CACHE_TTL_MS) : 0;
  const approvalCacheMaxEntries =
    cacheConfig !== false ? (cacheConfig.maxEntries ?? DEFAULT_APPROVAL_CACHE_MAX_ENTRIES) : 0;
  const approvalCache = cacheConfig !== false ? new Map<number, ApprovalCacheEntry>() : undefined;

  // Precompute a fingerprint for the backend config so different middleware instances
  // with different backends produce different approval cache keys.
  // Since the backend is opaque, we use the backend object identity via a stable random tag.
  const backendFingerprint = cacheConfig !== false ? fnv1a(String(Math.random())) : 0;

  const capabilityFragment: CapabilityFragment = {
    label: "permissions",
    description: config.description ?? "Permission checks enabled",
  };

  /** Fire-and-forget audit log for permission decisions. */
  function auditDecision(
    ctx: TurnContext,
    resource: string,
    decision: PermissionDecision,
    durationMs: number,
  ): void {
    if (auditSink === undefined) return;
    const entry: AuditEntry = {
      timestamp: clock(),
      sessionId: ctx.session.sessionId,
      agentId: ctx.session.agentId,
      turnIndex: ctx.turnIndex,
      kind: "tool_call",
      durationMs,
      metadata: {
        permissionCheck: true,
        resource,
        effect: decision.effect,
        ...(decision.effect !== "allow" ? { reason: decision.reason } : {}),
      },
    };
    void auditSink.log(entry).catch((e: unknown) => {
      swallowError(e, { package: "middleware-permissions", operation: "auditSink.log" });
    });
  }

  /** Build a PermissionQuery from a tool invocation context. */
  function queryForTool(ctx: TurnContext, resource: string): PermissionQuery {
    return {
      principal: ctx.session.agentId,
      action: "invoke",
      resource,
      ...(ctx.session.userId !== undefined ? { context: { userId: ctx.session.userId } } : {}),
    };
  }

  /** Compute FNV-1a cache key from a PermissionQuery. */
  function decisionCacheKey(query: PermissionQuery): number {
    const base = `${query.principal}:${query.action}:${query.resource}`;
    const ctx = query.context ? JSON.stringify(query.context) : "";
    return fnv1a(`${base}:${ctx}`);
  }

  /** Resolve a permission decision — cache-first, then CB guard, then backend. Fail closed. */
  async function resolveDecision(query: PermissionQuery): Promise<PermissionDecision> {
    if (cache !== undefined) {
      const key = decisionCacheKey(query);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
    }

    if (cb !== undefined && !cb.isAllowed()) {
      return { effect: "deny", reason: "Permission backend circuit open — failing closed" };
    }

    let decision: PermissionDecision; // assigned inside try/catch — cannot use const
    try {
      decision = await backend.check(query);
    } catch (e: unknown) {
      cb?.recordFailure();
      throw KoiRuntimeError.from("PERMISSION", "Permission check failed (fail closed)", {
        context: { resource: query.resource },
        cause: e,
      });
    }

    cb?.recordSuccess();

    if (cache !== undefined) {
      cache.set(decisionCacheKey(query), decision);
    }

    return decision;
  }

  /** Resolve decisions for a batch of queries. Uses checkBatch if available. */
  async function resolveBatch(
    queries: readonly PermissionQuery[],
  ): Promise<readonly PermissionDecision[]> {
    if (queries.length === 0) return [];

    if (cb !== undefined && !cb.isAllowed()) {
      return queries.map(() => ({
        effect: "deny" as const,
        reason: "Permission backend circuit open — failing closed",
      }));
    }

    // Partition into cache hits and misses
    const results: Array<PermissionDecision | undefined> = new Array(queries.length);
    const missIndices: number[] = [];
    const missQueries: PermissionQuery[] = [];

    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      if (q === undefined) continue;
      if (cache !== undefined) {
        const hit = cache.get(decisionCacheKey(q));
        if (hit !== undefined) {
          results[i] = hit;
          continue;
        }
      }
      missIndices.push(i);
      missQueries.push(q);
    }

    // All hits — skip backend entirely
    if (missQueries.length === 0) {
      return results as readonly PermissionDecision[];
    }

    let missDecisions: readonly PermissionDecision[]; // assigned inside try/catch — cannot use const
    try {
      missDecisions = backend.checkBatch
        ? await backend.checkBatch(missQueries)
        : await Promise.all(missQueries.map((q) => backend.check(q)));
    } catch (e: unknown) {
      cb?.recordFailure();
      throw KoiRuntimeError.from("PERMISSION", "Batch permission check failed (fail closed)", {
        cause: e,
      });
    }

    cb?.recordSuccess();

    // Merge miss results back and cache them
    for (let i = 0; i < missDecisions.length; i++) {
      const d = missDecisions[i];
      const idx = missIndices[i];
      if (d !== undefined && idx !== undefined) {
        results[idx] = d;
        if (cache !== undefined) {
          const q = missQueries[i];
          if (q !== undefined) cache.set(decisionCacheKey(q), d);
        }
      }
    }

    // Fail closed: any slot not filled by cache or backend defaults to deny
    const MISSING_DENY: PermissionDecision = {
      effect: "deny",
      reason: "No decision returned by permission backend — failing closed",
    };
    for (let i = 0; i < results.length; i++) {
      if (results[i] === undefined) {
        results[i] = MISSING_DENY;
      }
    }

    return results as readonly PermissionDecision[];
  }

  return {
    name: "permissions",
    priority: 100,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async onSessionEnd(_ctx: SessionContext): Promise<void> {
      if (backend.dispose) {
        await backend.dispose();
      }
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      if (!request.tools?.length) return next(request);

      const queries = request.tools.map((t) => queryForTool(ctx, t.name));
      const startMs = clock();
      const decisions = await resolveBatch(queries);
      const durationMs = clock() - startMs;

      // Audit each decision and filter out denied tools — keep allow + ask.
      // Fail closed: missing decisions are treated as deny.
      const filtered = request.tools.filter((t, i) => {
        const d = decisions[i];
        if (d === undefined) return false;
        auditDecision(ctx, t.name, d, durationMs);
        return d.effect !== "deny";
      });

      return next({ ...request, tools: filtered });
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const query = queryForTool(ctx, request.toolId);
      const startMs = clock();
      const decision = await resolveDecision(query);
      auditDecision(ctx, request.toolId, decision, clock() - startMs);

      if (decision.effect === "allow") {
        return next(request);
      }

      if (decision.effect === "deny") {
        throw KoiRuntimeError.from("PERMISSION", decision.reason, {
          context: { toolId: request.toolId },
        });
      }

      // decision.effect === "ask"

      // Check approval cache before prompting (true LRU: delete+reinsert on hit)
      if (approvalCache !== undefined) {
        const userId = ctx.session.userId ?? "__anonymous__";
        const approvalKey = computeApprovalCacheKey(
          backendFingerprint,
          userId,
          ctx.session.agentId,
          request.toolId,
          request.input,
        );
        const entry = approvalCache.get(approvalKey);
        if (entry !== undefined) {
          const expired = approvalCacheTtlMs > 0 && clock() - entry.cachedAt >= approvalCacheTtlMs;
          if (expired) {
            approvalCache.delete(approvalKey);
          } else {
            // LRU refresh: delete + reinsert moves to end of iteration order
            approvalCache.delete(approvalKey);
            approvalCache.set(approvalKey, { cachedAt: entry.cachedAt });
            return next(request);
          }
        }
      }

      if (!approvalHandler) {
        throw KoiRuntimeError.from(
          "PERMISSION",
          `No approval handler configured for tool "${request.toolId}"`,
          { context: { toolId: request.toolId } },
        );
      }

      const ac = new AbortController();
      const approved = await Promise.race([
        approvalHandler.requestApproval(request.toolId, request.input, decision.reason),
        new Promise<never>((_, reject) => {
          const timerId = setTimeout(() => {
            reject(
              KoiRuntimeError.from(
                "TIMEOUT",
                `Approval timed out after ${approvalTimeoutMs}ms for tool "${request.toolId}"`,
                { context: { toolId: request.toolId, timeoutMs: approvalTimeoutMs } },
              ),
            );
          }, approvalTimeoutMs);
          ac.signal.addEventListener("abort", () => clearTimeout(timerId), { once: true });
        }),
      ]).finally(() => {
        ac.abort();
      });

      if (approved) {
        // Cache the approval (only approvals, not denials)
        if (approvalCache !== undefined) {
          const userId = ctx.session.userId ?? "__anonymous__";
          const approvalKey = computeApprovalCacheKey(
            backendFingerprint,
            userId,
            ctx.session.agentId,
            request.toolId,
            request.input,
          );
          if (approvalCache.size >= approvalCacheMaxEntries) {
            // LRU eviction: Map iteration order is insertion order, so first key is oldest
            const oldest = approvalCache.keys().next().value;
            if (oldest !== undefined) approvalCache.delete(oldest);
          }
          approvalCache.set(approvalKey, { cachedAt: clock() });
        }
        return next(request);
      }

      throw KoiRuntimeError.from("PERMISSION", `Approval denied for tool "${request.toolId}"`, {
        context: { toolId: request.toolId },
      });
    },
  };
}

/**
 * Compose a cache key from all authorization-relevant dimensions.
 *
 * Uses null-byte separator to avoid collisions between components.
 * Input keys are sorted before serialization so `{a:1,b:2}` and `{b:2,a:1}`
 * produce the same cache key — property insertion order is an implementation
 * detail, not a semantic difference.
 */
function computeApprovalCacheKey(
  backendFingerprint: number,
  userId: string,
  _agentId: string,
  toolId: string,
  input: unknown,
): number {
  let serialized: string;
  try {
    const sorted =
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? Object.fromEntries(
            Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
          )
        : input;
    serialized = JSON.stringify(sorted);
  } catch (_e: unknown) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `Failed to serialize input for cache key — input must be JSON-serializable`,
      { context: { toolId } },
    );
  }
  // agentId intentionally excluded: approvals are user-scoped, not agent-scoped.
  // If the same user approves tool X with input Y, that approval is valid across
  // agents sharing the same middleware instance. The userId + backendFingerprint
  // already scope the cache appropriately.
  return fnv1a(`${backendFingerprint}\0${userId}\0${toolId}\0${serialized}`);
}
