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
import {
  type CircuitBreaker,
  createCircuitBreaker,
  KoiRuntimeError,
  swallowError,
} from "@koi/errors";
import { fnv1a } from "@koi/hash";
import { DEFAULT_DENY_MARKER } from "./classifier.js";
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
  readonly get: (key: number) => PermissionDecision | undefined;
  readonly set: (key: number, decision: PermissionDecision) => void;
  readonly clear: () => void;
} {
  const maxEntries = config.maxEntries ?? DEFAULT_CACHE_CONFIG.maxEntries;
  const allowTtl = config.allowTtlMs ?? DEFAULT_CACHE_CONFIG.allowTtlMs;
  const denyTtl = config.denyTtlMs ?? DEFAULT_CACHE_CONFIG.denyTtlMs;
  const entries = new Map<number, DecisionCacheEntry>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (clock() >= entry.expiresAt) {
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
      entries.set(key, { decision, expiresAt: clock() + ttl });
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
  readonly has: (key: number) => boolean;
  readonly set: (key: number) => void;
  readonly clear: () => void;
} {
  const maxEntries = config.maxEntries ?? DEFAULT_APPROVAL_CACHE_MAX_ENTRIES;
  const ttlMs = config.ttlMs ?? DEFAULT_APPROVAL_CACHE_TTL_MS;
  const entries = new Map<number, ApprovalCacheEntry>();

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
// Cache key helpers
// ---------------------------------------------------------------------------

function decisionCacheKey(query: PermissionQuery): number {
  const ctx = query.context !== undefined ? JSON.stringify(query.context) : "";
  return fnv1a(`${query.principal}:${query.action}:${query.resource}:${ctx}`);
}

function computeApprovalCacheKey(
  backendFingerprint: number,
  userId: string,
  agentId: string,
  toolId: string,
  input: unknown,
): number {
  const sorted = sortTopLevelKeys(input);
  return fnv1a(`${backendFingerprint}\0${userId}\0${agentId}\0${toolId}\0${sorted}`);
}

function sortTopLevelKeys(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const obj = value as Record<string, unknown>;
  const sorted = Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = obj[key];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const PKG = "@koi/middleware-permissions";

export function createPermissionsMiddleware(config: PermissionsMiddlewareConfig): KoiMiddleware {
  const { backend, auditSink, description } = config;
  const clock = config.clock ?? Date.now;
  const approvalTimeoutMs = config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  // Circuit breaker (optional)
  const cb: CircuitBreaker | undefined =
    config.circuitBreaker !== undefined
      ? createCircuitBreaker(config.circuitBreaker, clock)
      : undefined;

  // Decision cache (optional)
  const decisionCache =
    config.cache !== undefined && config.cache !== false
      ? createDecisionCache(
          typeof config.cache === "object" ? config.cache : DEFAULT_CACHE_CONFIG,
          clock,
        )
      : undefined;

  // Approval cache (optional)
  const approvalCache =
    config.approvalCache !== undefined && config.approvalCache !== false
      ? createApprovalCache(
          typeof config.approvalCache === "object"
            ? config.approvalCache
            : {
                ttlMs: DEFAULT_APPROVAL_CACHE_TTL_MS,
                maxEntries: DEFAULT_APPROVAL_CACHE_MAX_ENTRIES,
              },
          clock,
        )
      : undefined;

  // Backend fingerprint for approval cache key isolation
  const backendFingerprint = fnv1a(String(Math.random()));

  // Denial tracker
  const tracker: DenialTracker = createDenialTracker();

  // Set of tool names that came from forged tools (tracked per model call)
  let forgedToolNames = new Set<string>();

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  function queryForTool(ctx: TurnContext, resource: string): PermissionQuery {
    const meta = ctx.metadata;
    const hasKeys = Object.keys(meta).length > 0;
    if (hasKeys) {
      return { principal: ctx.session.agentId, action: "invoke", resource, context: meta };
    }
    return { principal: ctx.session.agentId, action: "invoke", resource };
  }

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
        resource,
        effect: decision.effect,
        ...(decision.effect !== "allow" ? { reason: decision.reason } : {}),
      },
    };
    void sink.log(entry).catch((e: unknown) => {
      swallowError(e, { package: PKG, operation: "audit" });
    });
  }

  async function resolveDecision(query: PermissionQuery): Promise<PermissionDecision> {
    // Circuit breaker check
    if (cb !== undefined && !cb.isAllowed()) {
      return { effect: "deny", reason: "Permission backend circuit open — failing closed" };
    }

    // Cache check
    if (decisionCache !== undefined) {
      const cached = decisionCache.get(decisionCacheKey(query));
      if (cached !== undefined) return cached;
    }

    try {
      const decision = await backend.check(query);
      if (cb !== undefined) cb.recordSuccess();
      if (decisionCache !== undefined) {
        decisionCache.set(decisionCacheKey(query), decision);
      }
      return decision;
    } catch (e: unknown) {
      if (cb !== undefined) cb.recordFailure();
      return {
        effect: "deny",
        reason: `Permission backend error — failing closed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async function resolveBatch(
    queries: readonly PermissionQuery[],
  ): Promise<readonly PermissionDecision[]> {
    if (queries.length === 0) return [];

    // Partition into cached and uncached
    const results: (PermissionDecision | undefined)[] = new Array(queries.length).fill(undefined);
    const uncachedIndices: number[] = [];

    if (decisionCache !== undefined) {
      for (let i = 0; i < queries.length; i++) {
        const query = queries[i]!;
        const cached = decisionCache.get(decisionCacheKey(query));
        if (cached !== undefined) {
          results[i] = cached;
        } else {
          uncachedIndices.push(i);
        }
      }
    } else {
      for (let i = 0; i < queries.length; i++) {
        uncachedIndices.push(i);
      }
    }

    if (uncachedIndices.length === 0) {
      return results as readonly PermissionDecision[];
    }

    // Circuit breaker
    if (cb !== undefined && !cb.isAllowed()) {
      const deny: PermissionDecision = {
        effect: "deny",
        reason: "Permission backend circuit open — failing closed",
      };
      for (const i of uncachedIndices) {
        results[i] = deny;
      }
      return results as readonly PermissionDecision[];
    }

    // Resolve uncached queries
    const uncachedQueries = uncachedIndices.map((i) => queries[i]!);
    try {
      let decisions: readonly PermissionDecision[];
      if (backend.checkBatch !== undefined) {
        decisions = await backend.checkBatch(uncachedQueries);
      } else {
        decisions = await Promise.all(uncachedQueries.map((q) => backend.check(q)));
      }

      if (cb !== undefined) cb.recordSuccess();

      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j]!;
        const decision = decisions[j]!;
        results[idx] = decision;
        if (decisionCache !== undefined) {
          decisionCache.set(decisionCacheKey(queries[idx]!), decision);
        }
      }
    } catch (e: unknown) {
      if (cb !== undefined) cb.recordFailure();
      const deny: PermissionDecision = {
        effect: "deny",
        reason: `Permission backend error — failing closed: ${e instanceof Error ? e.message : String(e)}`,
      };
      for (const i of uncachedIndices) {
        results[i] = deny;
      }
    }

    return results as readonly PermissionDecision[];
  }

  async function filterTools(ctx: TurnContext, request: ModelRequest): Promise<ModelRequest> {
    const tools = request.tools;
    if (tools === undefined || tools.length === 0) return request;

    const queries = tools.map((t) => queryForTool(ctx, t.name));
    const decisions = await resolveBatch(queries);

    // Track forged tools for wrapToolCall override
    const newForged = new Set<string>();

    const filtered = tools.filter((tool, i) => {
      const decision = decisions[i]!;
      if (auditSink !== undefined) {
        auditDecision(ctx, tool.name, decision, 0, auditSink);
      }
      if (decision.effect === "deny") {
        tracker.record({
          toolId: tool.name,
          reason: decision.reason,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
        });
        return false;
      }
      // Track forged tools that bypassed deny
      if (
        "origin" in tool &&
        (tool as unknown as { readonly origin: string }).origin === "forged"
      ) {
        newForged.add(tool.name);
      }
      return true;
    });

    forgedToolNames = newForged;

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

    async onSessionEnd(_ctx: SessionContext): Promise<void> {
      tracker.clear();
      decisionCache?.clear();
      approvalCache?.clear();
      await backend.dispose?.();
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
      const query = queryForTool(ctx, request.toolId);
      const startMs = clock();
      const decision = await resolveDecision(query);
      const durationMs = clock() - startMs;

      if (auditSink !== undefined) {
        auditDecision(ctx, request.toolId, decision, durationMs, auditSink);
      }

      if (decision.effect === "deny") {
        // Forged tool override: allow if denial is default-deny (not explicit)
        if (forgedToolNames.has(request.toolId) && decision.reason.includes(DEFAULT_DENY_MARKER)) {
          return next(request);
        }

        tracker.record({
          toolId: request.toolId,
          reason: decision.reason,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
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

    // Check approval cache
    if (approvalCache !== undefined) {
      const userId = ctx.session.userId ?? "__anonymous__";
      const cacheKey = computeApprovalCacheKey(
        backendFingerprint,
        userId,
        ctx.session.agentId,
        request.toolId,
        request.input,
      );

      if (approvalCache.has(cacheKey)) {
        return next(request);
      }
    }

    // Request approval with timeout
    const ac = new AbortController();

    try {
      const approvalResult = await Promise.race([
        approvalHandler({
          toolId: request.toolId,
          input: request.input,
          reason: decision.reason,
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
      ]).finally(() => ac.abort());

      if (approvalResult.kind === "deny") {
        tracker.record({
          toolId: request.toolId,
          reason: approvalResult.reason,
          timestamp: clock(),
          principal: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
        });

        throw new KoiRuntimeError({
          code: "PERMISSION",
          message: `Tool "${request.toolId}" denied by approval handler: ${approvalResult.reason}`,
          retryable: false,
        });
      }

      // Cache the approval
      if (approvalCache !== undefined) {
        const userId = ctx.session.userId ?? "__anonymous__";
        const cacheKey = computeApprovalCacheKey(
          backendFingerprint,
          userId,
          ctx.session.agentId,
          request.toolId,
          request.input,
        );
        approvalCache.set(cacheKey);
      }

      // Handle "modify" — use updated input
      if (approvalResult.kind === "modify") {
        return next({ ...request, input: approvalResult.updatedInput });
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
