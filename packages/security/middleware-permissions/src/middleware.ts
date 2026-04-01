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
// fnv1a no longer used for cache keys (collision-unsafe for security decisions)
import { isDefaultDeny } from "./classifier.js";
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
// Cache key helpers
// ---------------------------------------------------------------------------

/** Full serialized key — collision-safe for security-sensitive cache lookups. */
function decisionCacheKey(query: PermissionQuery): string {
  const ctx = query.context !== undefined ? JSON.stringify(query.context) : "";
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
  context: string,
): string {
  const sorted = sortTopLevelKeys(input);
  return `${backendFingerprint}\0${sessionId}\0${userId}\0${agentId}\0${toolId}\0${sorted}\0${context}`;
}

/** Serialize turn-scoped context for inclusion in approval cache keys. */
function serializeTurnContext(ctx: TurnContext): string {
  const meta = ctx.metadata;
  return Object.keys(meta).length > 0 ? JSON.stringify(meta) : "";
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

  // Backend fingerprint for approval cache key isolation (random string per instance)
  const backendFingerprint = String(Math.random());

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

  // Forged tool names scoped per turn (keyed by turnId to prevent cross-turn leaks)
  const forgedToolsByTurn = new Map<string, Set<string>>();

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  function queryForTool(ctx: TurnContext, resource: string): PermissionQuery {
    // Build principal with user/session scope for tenant isolation.
    // Format: "agentId:userId:sessionId" — ensures decision cache keys
    // and backend checks are scoped per-user and per-session.
    const userId = ctx.session.userId ?? "__anonymous__";
    const sessionId = ctx.session.sessionId as string;
    const principal = `${ctx.session.agentId}:${userId}:${sessionId}`;

    const meta = ctx.metadata;
    const hasKeys = Object.keys(meta).length > 0;
    if (hasKeys) {
      return { principal, action: "invoke", resource, context: meta };
    }
    return { principal, action: "invoke", resource };
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

    // Track forged tools scoped to this session+turn (composite key
    // ensures no cross-session bypass even if turnIds are not globally unique)
    const turnForged = new Set<string>();
    const turnKey = `${ctx.session.sessionId as string}:${ctx.turnId as string}`;

    const sessionTracker = getTracker(ctx.session.sessionId as string);

    const filtered = tools.filter((tool, i) => {
      const decision = decisions[i]!;
      if (auditSink !== undefined) {
        auditDecision(ctx, tool.name, decision, 0, auditSink);
      }
      if (decision.effect === "deny") {
        sessionTracker.record({
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
        turnForged.add(tool.name);
      }
      return true;
    });

    // Store forged tools for this turn only
    if (turnForged.size > 0) {
      forgedToolsByTurn.set(turnKey, turnForged);
    } else {
      forgedToolsByTurn.delete(turnKey);
    }

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
      const sessionTracker = trackersBySession.get(sid);
      if (sessionTracker !== undefined) {
        sessionTracker.clear();
        trackersBySession.delete(sid);
      }
      // Remove forged-tool entries belonging to this session only
      const prefix = `${sid}:`;
      for (const key of forgedToolsByTurn.keys()) {
        if (key.startsWith(prefix)) {
          forgedToolsByTurn.delete(key);
        }
      }
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      // Eagerly clean forged-tool state after each turn to prevent
      // unbounded memory growth in long-lived sessions
      const turnKey = `${ctx.session.sessionId as string}:${ctx.turnId as string}`;
      forgedToolsByTurn.delete(turnKey);
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
        // Forged tool override: allow if denial is default-deny (not explicit).
        // Uses structured symbol flag — never parses reason text.
        // Scoped to the current turn to prevent cross-turn bypass.
        const turnKey = `${ctx.session.sessionId as string}:${ctx.turnId as string}`;
        const turnForged = forgedToolsByTurn.get(turnKey);
        if (turnForged?.has(request.toolId) && isDefaultDeny(decision)) {
          return next(request);
        }

        getTracker(ctx.session.sessionId as string).record({
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
      const ctxStr = serializeTurnContext(ctx);
      const cacheKey = computeApprovalCacheKey(
        backendFingerprint,
        ctx.session.sessionId as string,
        userId,
        ctx.session.agentId,
        request.toolId,
        request.input,
        ctxStr,
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
        getTracker(ctx.session.sessionId as string).record({
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
        );
        approvalCache.set(cacheKey);
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
