/**
 * Call dedup middleware — caches deterministic tool call results.
 *
 * Identical tool calls (same sessionId + toolId + input) within the TTL
 * return the cached response instantly, avoiding redundant execution.
 *
 * Priority 185: runs after call-limits (175), before pay (200).
 */

import type { JsonObject } from "@koi/core/common";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { computeContentHash } from "@koi/hash";
import {
  type CallDedupConfig,
  DEFAULT_EXCLUDE,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
} from "./config.js";
import { createInMemoryDedupStore } from "./store.js";

function defaultHashFn(sessionId: string, toolId: string, input: JsonObject): string {
  return computeContentHash({ session: sessionId, tool: toolId, input });
}

/**
 * Creates a call dedup middleware that caches deterministic tool call results.
 *
 * Tools in the exclude list (merged with DEFAULT_EXCLUDE) always execute.
 * If an include list is provided, only listed tools are cached (minus excludes).
 * Errors, blocked responses, and exceptions are never cached.
 */
export function createCallDedupMiddleware(config?: CallDedupConfig): KoiMiddleware {
  const ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const store = config?.store ?? createInMemoryDedupStore(maxEntries);
  const now = config?.now ?? Date.now;
  const onCacheHit = config?.onCacheHit;
  const userHashFn = config?.hashFn;
  // Merge user excludes with defaults
  const excludeSet = new Set<string>([...DEFAULT_EXCLUDE, ...(config?.exclude ?? [])]);
  const includeSet = config?.include !== undefined ? new Set<string>(config.include) : undefined;

  function isCacheable(toolId: string): boolean {
    if (excludeSet.has(toolId)) return false;
    if (includeSet !== undefined) return includeSet.has(toolId);
    return true;
  }

  function computeCacheKey(sessionId: string, toolId: string, input: JsonObject): string {
    if (userHashFn !== undefined) {
      return userHashFn(sessionId, toolId, input);
    }
    return defaultHashFn(sessionId, toolId, input);
  }

  const capabilityFragment: CapabilityFragment = {
    label: "call-dedup",
    description: "Caches identical deterministic tool call results within TTL",
  };

  return {
    name: "koi:call-dedup",
    priority: 185,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const toolId = request.toolId;

      // Skip cache for excluded / non-included tools
      if (!isCacheable(toolId)) {
        return next(request);
      }

      const sessionId = ctx.session.sessionId;
      const cacheKey = computeCacheKey(sessionId, toolId, request.input);
      const currentTime = now();

      // Check cache
      const cached = await store.get(cacheKey);
      if (cached !== undefined) {
        if (cached.expiresAt > currentTime) {
          // Cache hit — notify observer (errors must not break cache behavior)
          if (onCacheHit !== undefined) {
            try {
              onCacheHit({ sessionId, toolId, cacheKey });
            } catch (_e: unknown) {
              // Observability callback failure is non-fatal
            }
          }
          return {
            ...cached.response,
            metadata: { ...cached.response.metadata, cached: true },
          };
        }
        // Expired — clean up stale entry
        await store.delete(cacheKey);
      }

      // Cache miss — execute
      const response = await next(request);

      // Never cache blocked or error responses
      const meta = response.metadata;
      if (meta?.blocked === true || meta?.error === true) {
        return response;
      }

      // Fresh timestamp after tool execution for accurate TTL
      const storeTime = now();
      await store.set(cacheKey, {
        response,
        expiresAt: storeTime + ttlMs,
      });

      return response;
    },
  };
}
