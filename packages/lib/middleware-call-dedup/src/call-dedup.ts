/**
 * Call dedup middleware — caches deterministic tool call results within a session.
 *
 * Opt-in by design: callers MUST pass an `include` allowlist of tool ids they
 * have proven to be deterministic against immutable inputs. Without `include`,
 * the middleware is a passthrough — no caching takes place. This is a
 * deliberate safety choice: a default-on cache silently drops side-effecting
 * tool calls (task_create, file_write, koi_send_message…) and serves stale
 * snapshots from stateful read tools (task_list, notebook_read…) when other
 * tools have mutated the underlying resource.
 *
 * Within the allowlist, identical {sessionId, toolId, input} calls within
 * TTL return the cached ToolResponse with metadata.cached=true. The
 * DEFAULT_EXCLUDE list (mutating shell/file/agent tools) is still applied
 * as a hard floor even if a caller mistakenly adds them to `include`.
 * Errored or blocked responses are never cached.
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
  /**
   * In-flight requests by cache key. Coalesces concurrent identical calls
   * onto a single underlying execution to prevent the race where two
   * simultaneous misses both invoke `next` and store overlapping results.
   */
  readonly inFlight: Map<string, Promise<ToolResponse>>;
}

function isCacheable(s: DedupState, toolId: string): boolean {
  // Opt-in: no allowlist → passthrough. Caller has not declared any tool
  // safe to dedup, so we cannot make that decision for them.
  if (s.includeSet === undefined) return false;
  // DEFAULT_EXCLUDE is a hard floor — mutating tools are never cacheable
  // even if the caller mistakenly adds them to `include`.
  if (s.excludeSet.has(toolId)) return false;
  return s.includeSet.has(toolId);
}

function notifyHit(s: DedupState, sessionId: string, toolId: string, cacheKey: string): void {
  if (s.onCacheHit === undefined) return;
  try {
    s.onCacheHit({ sessionId, toolId, cacheKey });
  } catch {
    // observer errors must not break cache behavior
  }
}

async function executeAndStore(
  s: DedupState,
  cacheKey: string,
  request: ToolRequest,
  next: ToolHandler,
): Promise<ToolResponse> {
  const response = await next(request);
  const meta = response.metadata;
  if (meta?.blocked === true || meta?.error === true) return response;
  await s.store.set(cacheKey, { response, expiresAt: s.now() + s.ttlMs });
  return response;
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

  // Coalesce concurrent identical misses onto a single execution. Without
  // this, two simultaneous requests for the same key both miss the cache
  // and both call `next`, defeating dedup precisely under retry storms.
  const existing = s.inFlight.get(cacheKey);
  if (existing !== undefined) return existing;

  const promise = executeAndStore(s, cacheKey, request, next).finally(() => {
    s.inFlight.delete(cacheKey);
  });
  s.inFlight.set(cacheKey, promise);
  return promise;
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
    inFlight: new Map(),
  };
  return {
    name: "koi:call-dedup",
    // Phase + priority deliberately place dedup BEFORE call-limits (175):
    // a cache hit must short-circuit the chain so it does not burn quota.
    // Without this ordering, identical retries are blocked with
    // tool_call_limit_exceeded even though the cache could serve them.
    priority: 150,
    phase: "intercept",
    wrapToolCall: (ctx, request, next) => ddWrapToolCall(state, ctx, request, next),
    describeCapabilities: () => state.capability,
  } satisfies KoiMiddleware;
}
