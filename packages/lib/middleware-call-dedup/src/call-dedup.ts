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
  readonly maxEntries: number;
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
  /**
   * Index of cache keys produced for each session. Used by `onSessionEnd`
   * to evict that session's entries and in-flight promises so a later run
   * reusing the same `sessionId` cannot receive cached results from — or
   * coalesce onto a still-running call belonging to — the terminated
   * session.
   */
  readonly keysBySession: Map<string, Set<string>>;
  /**
   * Per-session generation counter. Bumped on every `onSessionEnd`. An
   * in-flight `executeAndStore` captures the generation at start time
   * and refuses to write back if the live generation has advanced — so
   * a tool call still running when the session ends cannot repopulate
   * the cache for that (now dead) session id.
   */
  readonly sessionGen: Map<string, number>;
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

/**
 * Clone a ToolResponse at the cache boundary. `output` is `unknown` and
 * commonly an object/array; without cloning, any caller or downstream
 * middleware that mutates the first response mutates the cached entry,
 * silently corrupting every later hit.
 */
function cloneResponse(response: ToolResponse): ToolResponse {
  return structuredClone(response);
}

async function executeAndStore(
  s: DedupState,
  cacheKey: string,
  sessionId: string,
  generation: number,
  request: ToolRequest,
  next: ToolHandler,
): Promise<ToolResponse> {
  const response = await next(request);
  const meta = response.metadata;
  if (meta?.blocked === true || meta?.error === true) return response;
  // If the session ended (or was reused under a new generation) while the
  // tool call was in flight, drop the result instead of repopulating the
  // cache for a now-dead session id. Otherwise a later run reusing that
  // sessionId could receive stale output from the prior run.
  if ((s.sessionGen.get(sessionId) ?? 0) !== generation) return response;
  // Snapshot the response into the cache so later mutation by the caller
  // does not corrupt cached state.
  await s.store.set(cacheKey, { response: cloneResponse(response), expiresAt: s.now() + s.ttlMs });
  trackKey(s, sessionId, cacheKey);
  return response;
}

function trackKey(s: DedupState, sessionId: string, cacheKey: string): void {
  const existing = s.keysBySession.get(sessionId);
  if (existing === undefined) {
    s.keysBySession.set(sessionId, new Set([cacheKey]));
    return;
  }
  // FIFO cap matches the store's `maxEntries`. The store silently
  // LRU-evicts older entries above that cap, so any key tracked here
  // beyond `maxEntries` must already be stale in the store. Capping
  // prevents per-session bookkeeping from outgrowing the advertised
  // cache size for long-lived sessions with high input churn.
  if (existing.size >= s.maxEntries && !existing.has(cacheKey)) {
    const oldest = existing.values().next().value;
    if (oldest !== undefined) existing.delete(oldest);
  }
  existing.add(cacheKey);
}

function bumpGeneration(s: DedupState, sessionId: string): number {
  const next = (s.sessionGen.get(sessionId) ?? 0) + 1;
  // FIFO cap on `sessionGen`: per-session generation tracking is bounded
  // by `4 * maxEntries`. Eviction is safe — a stale read returns 0 which
  // matches the inflight-call's captured generation only for sessions
  // that never bumped, so the only failure mode is occasional
  // false-positive cache misses, never bad cache hits.
  if (!s.sessionGen.has(sessionId) && s.sessionGen.size >= s.maxEntries * 4) {
    const oldest = s.sessionGen.keys().next().value;
    if (oldest !== undefined) s.sessionGen.delete(oldest);
  }
  s.sessionGen.set(sessionId, next);
  return next;
}

async function evictSession(s: DedupState, sessionId: string): Promise<void> {
  // Bump generation FIRST so any executeAndStore call still in flight
  // sees the mismatch and refuses to write back. Eviction of currently
  // tracked entries follows. The sessionGen entry is intentionally
  // NOT removed here — late writebacks need the bumped value to detect
  // the gen mismatch. `sessionGen` is independently bounded by FIFO
  // eviction in `bumpGeneration` so long-running processes do not
  // accumulate per-session markers without bound.
  bumpGeneration(s, sessionId);
  const keys = s.keysBySession.get(sessionId);
  if (keys === undefined) return;
  s.keysBySession.delete(sessionId);
  for (const key of keys) {
    s.inFlight.delete(key);
    await s.store.delete(key);
  }
}

/**
 * Decide whether a request can participate in caching. Two conservative
 * bypasses keep dedup safe under realistic runtime conditions:
 *
 *   - `request.signal`: aborting a coalesced caller would abort the
 *     underlying shared execution for every other waiter. Until per-waiter
 *     fan-out is implemented, requests with cancellation tokens skip both
 *     the cache and the in-flight map and run independently.
 *   - `request.metadata`: per-call metadata (traceCallId, request-scoped
 *     correlation, future per-call permission scope) is part of the request
 *     identity but cannot be folded into the cache key without making cache
 *     hits effectively impossible. Refusing to cache metadata-tagged
 *     requests preserves correctness — a later identical call with
 *     different metadata never receives a stale earlier response.
 */
function isRequestCacheSafe(request: ToolRequest): boolean {
  // `signal` is the only field that genuinely cannot be coalesced:
  // aborting any one caller of a shared in-flight execution would cascade
  // to every other waiter sharing it. Until per-waiter fan-out is
  // implemented, signal-bearing requests run independently with no
  // caching.
  if (request.signal !== undefined) return false;
  // `metadata` (notably `metadata.traceCallId`) and `callId` are
  // observability/correlation fields stamped on every runtime request.
  // They are deliberately NOT identity-relevant for the cache key:
  // dedup's whole contract is "two identical tool calls return the same
  // result", and that statement must hold across distinct trace ids.
  // Cached responses are marked `metadata.cached = true` so downstream
  // observability can tell hits apart from real executions.
  return true;
}

async function ddWrapToolCall(
  s: DedupState,
  ctx: TurnContext,
  request: ToolRequest,
  next: ToolHandler,
): Promise<ToolResponse> {
  const toolId = request.toolId;
  if (!isCacheable(s, toolId)) return next(request);
  if (!isRequestCacheSafe(request)) return next(request);

  const sessionId = ctx.session.sessionId;
  const cacheKey = s.hashFn(sessionId, toolId, request.input);

  const cached = await s.store.get(cacheKey);
  if (cached !== undefined) {
    if (cached.expiresAt > s.now()) {
      notifyHit(s, sessionId, toolId, cacheKey);
      // Deep-clone so the cached entry is immune to caller-side mutation.
      const cloned = cloneResponse(cached.response);
      return {
        ...cloned,
        metadata: { ...cloned.metadata, cached: true },
      };
    }
    await s.store.delete(cacheKey);
  }

  // Coalesce concurrent identical misses onto a single execution. Safe here
  // because isRequestCacheSafe already bypassed any request carrying a
  // cancellation signal — coalesced callers all share metadata-free,
  // signal-free identity, so one caller cannot abort the others.
  const existing = s.inFlight.get(cacheKey);
  if (existing !== undefined) {
    trackKey(s, sessionId, cacheKey);
    return existing;
  }

  const generation = s.sessionGen.get(sessionId) ?? 0;
  const promise = executeAndStore(s, cacheKey, sessionId, generation, request, next).finally(() => {
    s.inFlight.delete(cacheKey);
  });
  s.inFlight.set(cacheKey, promise);
  trackKey(s, sessionId, cacheKey);
  return promise;
}

export function createCallDedupMiddleware(config?: CallDedupConfig): KoiMiddleware {
  const maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const state: DedupState = {
    ttlMs: config?.ttlMs ?? DEFAULT_TTL_MS,
    maxEntries,
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
    keysBySession: new Map(),
    sessionGen: new Map(),
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
    onSessionEnd: (ctx) => evictSession(state, ctx.sessionId),
    describeCapabilities: () => state.capability,
  } satisfies KoiMiddleware;
}
