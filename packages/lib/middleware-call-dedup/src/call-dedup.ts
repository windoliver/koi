/**
 * Call dedup middleware — caches deterministic tool call results within a session.
 *
 * Identical {sessionId, toolId, input} calls within TTL return the cached
 * ToolResponse with metadata.cached=true. Mutating tools in DEFAULT_EXCLUDE
 * always bypass the cache. Errored or blocked responses are never cached.
 */

import type {
  CapabilityFragment,
  JsonObject,
  KoiMiddleware,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { computeContentHash } from "@koi/hash";
import {
  type CallDedupConfig,
  DEFAULT_EXCLUDE,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
} from "./config.js";
import { createInMemoryDedupStore } from "./store.js";
import type { CacheHitInfo, CallDedupStore } from "./types.js";

function defaultHashFn(sessionId: string, toolId: string, input: JsonObject): string {
  return computeContentHash({ session: sessionId, tool: toolId, input });
}

interface DedupState {
  readonly ttlMs: number;
  readonly store: CallDedupStore;
  readonly now: () => number;
  readonly onCacheHit: ((info: CacheHitInfo) => void) | undefined;
  readonly hashFn: (sessionId: string, toolId: string, input: JsonObject) => string;
  readonly excludeSet: ReadonlySet<string>;
  readonly includeSet: ReadonlySet<string> | undefined;
  readonly capability: CapabilityFragment;
}

function isCacheable(s: DedupState, toolId: string): boolean {
  if (s.excludeSet.has(toolId)) return false;
  if (s.includeSet !== undefined) return s.includeSet.has(toolId);
  return true;
}

function notifyHit(s: DedupState, sessionId: string, toolId: string, cacheKey: string): void {
  if (s.onCacheHit === undefined) return;
  try {
    s.onCacheHit({ sessionId, toolId, cacheKey });
  } catch {
    // observer errors must not break cache behavior
  }
}

async function ddWrapToolCall(
  s: DedupState,
  ctx: TurnContext,
  request: ToolRequest,
  next: ToolHandler,
): Promise<ToolResponse> {
  const toolId = request.toolId;
  if (!isCacheable(s, toolId)) return next(request);

  const sessionId = ctx.session.sessionId;
  const cacheKey = s.hashFn(sessionId, toolId, request.input);
  const cached = await s.store.get(cacheKey);
  if (cached !== undefined) {
    if (cached.expiresAt > s.now()) {
      notifyHit(s, sessionId, toolId, cacheKey);
      return {
        ...cached.response,
        metadata: { ...cached.response.metadata, cached: true },
      };
    }
    await s.store.delete(cacheKey);
  }

  const response = await next(request);
  const meta = response.metadata;
  if (meta?.blocked === true || meta?.error === true) return response;
  await s.store.set(cacheKey, { response, expiresAt: s.now() + s.ttlMs });
  return response;
}

export function createCallDedupMiddleware(config?: CallDedupConfig): KoiMiddleware {
  const maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const state: DedupState = {
    ttlMs: config?.ttlMs ?? DEFAULT_TTL_MS,
    store: config?.store ?? createInMemoryDedupStore(maxEntries),
    now: config?.now ?? Date.now,
    onCacheHit: config?.onCacheHit,
    hashFn: config?.hashFn ?? defaultHashFn,
    excludeSet: new Set<string>([...DEFAULT_EXCLUDE, ...(config?.exclude ?? [])]),
    includeSet: config?.include !== undefined ? new Set<string>(config.include) : undefined,
    capability: {
      label: "call-dedup",
      description: "Caches identical deterministic tool call results within TTL",
    },
  };
  return {
    name: "koi:call-dedup",
    priority: 185,
    phase: "resolve",
    wrapToolCall: (ctx, request, next) => ddWrapToolCall(state, ctx, request, next),
    describeCapabilities: () => state.capability,
  } satisfies KoiMiddleware;
}
