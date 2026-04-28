/**
 * Circuit breaker middleware — per-provider fail-fast on unhealthy model providers.
 *
 * Wraps the `createCircuitBreaker` primitive from `@koi/errors` and applies it as
 * an intercept-phase middleware on `wrapModelCall` and `wrapModelStream`. Failures
 * within the configured window trip the circuit; subsequent calls fail fast with
 * a `RATE_LIMIT` `KoiError` until cooldown elapses, when a single probe is allowed.
 */

import type {
  CapabilityFragment,
  KoiError,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core";
import {
  type CircuitBreaker,
  type CircuitBreakerConfig,
  createCircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "@koi/errors";
import type { CircuitBreakerMiddlewareConfig } from "./types.js";

const DEFAULT_MAX_KEYS = 50;

function providerPrefix(model: string | undefined): string {
  if (model === undefined || model.length === 0) return "default";
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : model;
}

/**
 * Default key strategy: provider+session. Safe for shared/multi-tenant
 * runtimes — one tenant's quota exhaustion or bad credential cannot
 * blackhole every other session on the same provider. Single-tenant
 * deployments that want a shared provider-level breaker should opt in
 * with an explicit `extractKey: (m) => providerPrefix(m)`.
 */
function defaultExtractKey(model: string | undefined, ctx: TurnContext): string {
  return `${providerPrefix(model)}|${ctx.session.sessionId}`;
}

/**
 * Map a KoiError-style code to an HTTP-shaped status the breaker can filter.
 * Only upstream-shaped codes are returned; everything else is `undefined`
 * so non-provider errors do not poison the circuit.
 */
function statusFromCode(code: unknown): number | undefined {
  if (code === "RATE_LIMIT") return 429;
  if (code === "TIMEOUT") return 503;
  if (code === "EXTERNAL") return 502;
  return undefined;
}

/**
 * Extract an HTTP status code from a caught error — provider-originated only.
 *
 * Recognizes:
 *   - HTTP client / provider SDK shapes: top-level `status` / `statusCode`
 *   - The koi runtime adapter envelope: `Error(..., { cause: { code } })`
 *     where `cause.code` is a KoiErrorCode like `RATE_LIMIT` / `TIMEOUT`
 *     / `EXTERNAL`. The OpenAI-compatible adapter (and similar) wrap
 *     upstream HTTP failures this way, so reading the nested code is the
 *     only way to see real provider 429s/503s without a top-level status.
 *
 * Deliberately does NOT infer status from a TOP-level `code` field —
 * downstream local middleware (call-limits, internal throttles) emit
 * KoiError-shaped objects with `code: "RATE_LIMIT"` and no `cause`, and
 * counting those would let one session's local quota poison the shared
 * circuit for every other session on a healthy provider.
 *
 * Errors without any provider-shaped signal return `undefined`; the caller
 * uses that to skip recording a breaker failure.
 */
function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as Record<string, unknown>;
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  // Walk one level into `cause` — the runtime adapter envelope.
  if (typeof e.cause === "object" && e.cause !== null) {
    const c = e.cause as Record<string, unknown>;
    if (typeof c.status === "number") return c.status;
    if (typeof c.statusCode === "number") return c.statusCode;
    const fromCode = statusFromCode(c.code);
    if (fromCode !== undefined) return fromCode;
  }
  return undefined;
}

function createCircuitOpenError(key: string): KoiError {
  return {
    code: "RATE_LIMIT",
    message: `Circuit breaker open for "${key}" — too many recent failures`,
    retryable: true,
    context: { key },
  };
}

function createCapacityExhaustedError(key: string, maxKeys: number): KoiError {
  return {
    code: "RATE_LIMIT",
    message:
      `Circuit breaker capacity exhausted (${String(maxKeys)} keys, all active) — ` +
      `refusing new key "${key}" to preserve fail-fast under high-cardinality outage`,
    retryable: true,
    context: { key, maxKeys },
  };
}

async function* errorStream(error: KoiError): AsyncIterable<ModelChunk> {
  yield { kind: "error", message: error.message, code: error.code, retryable: error.retryable };
}

/**
 * Map a streamed `error` chunk to an HTTP status the breaker can filter.
 *
 * Streamed errors come from the model adapter, not from local middleware
 * (local middleware throw, they don't emit chunks). So an upstream-shaped
 * code on a stream chunk IS provider-originated and should count.
 *
 * Returns `undefined` for codes without a clear upstream mapping
 * (validation, abort, unknown) — those leave breaker state unchanged.
 */
function streamErrorStatus(chunk: {
  readonly code?: string | undefined;
  readonly retryable?: boolean | undefined;
}): number | undefined {
  return statusFromCode(chunk.code);
}

async function* trackedStream(
  source: AsyncIterable<ModelChunk>,
  breaker: CircuitBreaker,
  tookProbe: boolean,
): AsyncIterable<ModelChunk> {
  // Tracks whether the consumer broke out of the loop early (cancellation,
  // abort, downstream short-circuit). If they did, we MUST NOT count the
  // truncation as a provider failure — it's a local control-flow event.
  // Conversely, if the source's own iterator returns without a terminal
  // chunk while the consumer is still receiving, that's an upstream
  // truncation and IS counted (with no status, so failureStatusCodes can
  // suppress it if configured).
  let consumerCancelled = true;
  try {
    for await (const chunk of source) {
      if (chunk.kind === "error") {
        consumerCancelled = false;
        const status = streamErrorStatus(chunk);
        if (status !== undefined) breaker.recordFailure(status);
        yield chunk;
        return;
      }
      if (chunk.kind === "done") {
        consumerCancelled = false;
        breaker.recordSuccess();
        yield chunk;
        return;
      }
      yield chunk;
    }
    // for-await exited because the source ran out, not because the consumer
    // broke. We do NOT count this as a failure: the underlying
    // `recordFailure()` with no status counts unconditionally and would
    // bypass any restrictive `failureStatusCodes` configuration. A
    // truncated stream without a classified upstream error is not a
    // confirmed provider fault — only count when a status is present.
    consumerCancelled = false;
  } catch (err: unknown) {
    consumerCancelled = false;
    const status = extractStatusCode(err);
    if (status !== undefined) breaker.recordFailure(status);
    throw err;
  } finally {
    // Cancellation handling has two cases:
    //   - tookProbe=false: this invocation did not consume a HALF_OPEN probe
    //     slot, so we leave breaker state untouched. (The CLOSED happy path.)
    //   - tookProbe=true: this invocation consumed the HALF_OPEN probe.
    //     Without an explicit recordSuccess/recordFailure, `probeInFlight`
    //     stays true forever and isAllowed() rejects every future call,
    //     wedging the provider. Treat an abandoned probe as a failure so
    //     the circuit returns to OPEN and can re-arm on the next cooldown.
    if (consumerCancelled && tookProbe) {
      // Local cancellation (consumer aborted, downstream short-circuit,
      // caller timeout) is NOT a provider fault. Use `releaseProbe()`
      // to clear `probeInFlight` without mutating failure history —
      // otherwise repeated client-side aborts would re-open a healthy
      // circuit and block recovery indefinitely.
      breaker.releaseProbe();
    }
  }
}

interface CbState {
  readonly breakerConfig: CircuitBreakerConfig;
  readonly extractKey: (model: string | undefined, ctx: TurnContext) => string;
  readonly maxKeys: number;
  readonly clock: (() => number) | undefined;
  readonly breakers: Map<string, CircuitBreaker>;
  readonly warnGuard: { warned: boolean };
  /**
   * Reverse index: each session-id to the set of breaker keys it has
   * touched. Lets `onSessionEnd` reclaim keys when their last owner
   * leaves. With the default provider-scoped extractor, multiple
   * concurrent sessions share a single breaker — so eviction MUST be
   * refcounted: deleting a shared CLOSED breaker when one session
   * happens to end would erase recent failure history for every
   * remaining session on the same provider, delaying or preventing a
   * legitimate trip to OPEN under cross-session incidents.
   */
  readonly keysBySession: Map<string, Set<string>>;
  /**
   * Forward index: each breaker key to the set of sessions currently
   * referencing it. A key is reclaimable only when this set becomes
   * empty AND the breaker is CLOSED. OPEN/HALF_OPEN circuits are
   * always preserved.
   */
  readonly keyOwners: Map<string, Set<string>>;
}

function trackSessionKey(s: CbState, sessionId: string, key: string): void {
  const sessions = s.keysBySession.get(sessionId);
  if (sessions !== undefined) sessions.add(key);
  else s.keysBySession.set(sessionId, new Set([key]));
  const owners = s.keyOwners.get(key);
  if (owners !== undefined) owners.add(sessionId);
  else s.keyOwners.set(key, new Set([sessionId]));
}

function evictSessionKeys(s: CbState, sessionId: string): void {
  const keys = s.keysBySession.get(sessionId);
  if (keys === undefined) return;
  s.keysBySession.delete(sessionId);
  for (const k of keys) {
    const owners = s.keyOwners.get(k);
    if (owners === undefined) continue;
    owners.delete(sessionId);
    // Refcount: keep the breaker alive while any session still owns it
    // (e.g., shared provider-scoped extractKey). When the last owner
    // leaves, reclaim regardless of state — including OPEN/HALF_OPEN.
    // Holding ownerless OPEN circuits would let an outage permanently
    // wedge the map at capacity: many session-scoped circuits trip to
    // OPEN, sessions end, the provider recovers, but new sessions
    // forever hit `RATE_LIMIT` capacity-exhaustion because nothing
    // reclaims the orphaned OPEN entries.
    if (owners.size > 0) continue;
    s.keyOwners.delete(k);
    s.breakers.delete(k);
  }
}

function getOrCreateBreaker(s: CbState, key: string): CircuitBreaker | undefined {
  const existing = s.breakers.get(key);
  if (existing !== undefined) return existing;
  // Enforce maxKeys as a HARD cap. Keys are caller-controlled, so an
  // unbounded map is a memory leak under high cardinality.
  //
  // Eviction policy: only CLOSED entries are evictable. We MUST NOT
  // evict OPEN/HALF_OPEN circuits — that would silently reset a tripped
  // breaker and resume sending traffic to a still-unhealthy provider,
  // defeating fail-fast exactly during the high-cardinality failure
  // storms this guard is meant to handle.
  //
  // If the map is at capacity AND every existing entry is OPEN/HALF_OPEN,
  // we refuse to insert. The caller receives `undefined` and the request
  // proceeds without breaker coverage for that key, but `s.breakers`
  // does not grow past `maxKeys`. This is the only safe behavior under
  // a key-explosion failure storm: insert-past-cap would lose the bound,
  // active-eviction would lose fail-fast.
  if (s.breakers.size >= s.maxKeys) {
    if (!s.warnGuard.warned) {
      s.warnGuard.warned = true;
      console.warn(
        `[circuit-breaker] key map reached ${String(s.maxKeys)} entries — evicting oldest CLOSED; possible key explosion`,
      );
    }
    // Eviction priority (best to worst victim):
    //   1. Ownerless CLOSED with zero accumulated failures (truly idle).
    //   2. Owned CLOSED with zero accumulated failures (no recent
    //      failure history to lose, even if a session still references it).
    // We deliberately NEVER evict:
    //   - OPEN/HALF_OPEN entries (resetting them resumes upstream traffic
    //     to a still-unhealthy provider, defeating fail-fast).
    //   - CLOSED entries with non-zero failureCount (their partial ring
    //     buffer is one or two failures away from tripping; recreating
    //     the breaker fresh lets the next failure escape and silently
    //     loses fail-fast accounting under high-cardinality storms).
    // If only rank-3 (owned+failures) candidates remain, refuse insertion.
    let evicted = false;
    let bestVictim: string | undefined;
    let bestRank = 3;
    for (const [k, b] of s.breakers) {
      const snap = b.getSnapshot();
      if (snap.state !== "CLOSED") continue;
      if (snap.failureCount > 0) continue;
      const owners = s.keyOwners.get(k);
      const owned = owners !== undefined && owners.size > 0;
      const rank = owned ? 2 : 1;
      if (rank < bestRank) {
        bestRank = rank;
        bestVictim = k;
        if (rank === 1) break;
      }
    }
    if (bestVictim !== undefined) {
      s.breakers.delete(bestVictim);
      const owners = s.keyOwners.get(bestVictim);
      if (owners !== undefined) {
        for (const sid of owners) s.keysBySession.get(sid)?.delete(bestVictim);
        s.keyOwners.delete(bestVictim);
      }
      evicted = true;
    }
    if (!evicted) {
      console.warn(
        `[circuit-breaker] key map at ${String(s.maxKeys)} entries with all circuits active — refusing new key "${key}"`,
      );
      return undefined;
    }
  }
  const fresh =
    s.clock !== undefined
      ? createCircuitBreaker(s.breakerConfig, s.clock)
      : createCircuitBreaker(s.breakerConfig);
  s.breakers.set(key, fresh);
  return fresh;
}

async function cbWrapModelCall(
  s: CbState,
  ctx: TurnContext,
  request: ModelRequest,
  next: ModelHandler,
): Promise<ModelResponse> {
  const key = s.extractKey(request.model, ctx);
  const breaker = getOrCreateBreaker(s, key);
  // Capacity exhausted with every existing entry active. Reject fast
  // with a local RATE_LIMIT — passthrough would let the high-cardinality
  // outage that filled the map degrade into full upstream timeouts for
  // every new key, exactly the failure mode this middleware exists to
  // contain.
  if (breaker === undefined) throw createCapacityExhaustedError(key, s.maxKeys);
  trackSessionKey(s, ctx.session.sessionId, key);
  if (!breaker.isAllowed()) {
    throw createCircuitOpenError(key);
  }
  try {
    const response = await next(request);
    breaker.recordSuccess();
    return response;
  } catch (err: unknown) {
    // Only count failures with a provider-set HTTP status. Errors without one
    // are local (validation, our own RATE_LIMIT, abort) and must not poison
    // the shared circuit for a healthy provider.
    const status = extractStatusCode(err);
    if (status !== undefined) breaker.recordFailure(status);
    throw err;
  }
}

function cbWrapModelStream(
  s: CbState,
  ctx: TurnContext,
  request: ModelRequest,
  next: ModelStreamHandler,
): AsyncIterable<ModelChunk> {
  const key = s.extractKey(request.model, ctx);
  const breaker = getOrCreateBreaker(s, key);
  // Capacity exhausted — reject the stream with the same local
  // RATE_LIMIT used by cbWrapModelCall. See that path for rationale.
  if (breaker === undefined) return errorStream(createCapacityExhaustedError(key, s.maxKeys));
  trackSessionKey(s, ctx.session.sessionId, key);
  // Snapshot before isAllowed so we can detect an OPEN→HALF_OPEN transition
  // that consumed our probe slot. The breaker primitive marks `probeInFlight`
  // when isAllowed returns true from OPEN or HALF_OPEN, so we MUST eventually
  // call recordSuccess/recordFailure or the circuit wedges (see #1419 round 5).
  const stateBefore = breaker.getSnapshot().state;
  if (!breaker.isAllowed()) {
    return errorStream(createCircuitOpenError(key));
  }
  // We took a probe slot iff the breaker is now HALF_OPEN. This is true after
  // either OPEN→HALF_OPEN (cooldown elapsed) or HALF_OPEN remaining HALF_OPEN
  // (we're the probe). CLOSED→CLOSED is the normal path; no probe consumed.
  const tookProbe =
    breaker.getSnapshot().state === "HALF_OPEN" &&
    (stateBefore === "OPEN" || stateBefore === "HALF_OPEN");
  // `next(request)` can throw synchronously before returning an
  // AsyncIterable (e.g., a downstream call-limit middleware throws when
  // the session budget is exhausted, or a stream factory fails during
  // setup). If a probe was taken, none of `trackedStream`'s cleanup
  // would run and `probeInFlight` would leak — wedging the circuit in
  // HALF_OPEN forever even though the provider is healthy.
  let stream: AsyncIterable<ModelChunk>;
  try {
    stream = next(request);
  } catch (err: unknown) {
    if (tookProbe) {
      const status = extractStatusCode(err);
      if (status !== undefined) {
        breaker.recordFailure(status);
      } else {
        breaker.releaseProbe();
      }
    }
    throw err;
  }
  return trackedStream(stream, breaker, tookProbe);
}

function cbDescribe(s: CbState): CapabilityFragment {
  const open: string[] = [];
  for (const [key, breaker] of s.breakers) {
    if (breaker.getSnapshot().state === "OPEN") open.push(key);
  }
  if (open.length === 0) {
    return { label: "circuit-breaker", description: "All circuits closed (healthy)." };
  }
  return { label: "circuit-breaker", description: `Circuit open for: ${open.join(", ")}.` };
}

export function createCircuitBreakerMiddleware(
  config?: CircuitBreakerMiddlewareConfig,
): KoiMiddleware {
  const state: CbState = {
    breakerConfig: { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config?.breaker },
    extractKey: config?.extractKey ?? defaultExtractKey,
    maxKeys: config?.maxKeys ?? DEFAULT_MAX_KEYS,
    clock: config?.clock,
    breakers: new Map(),
    warnGuard: { warned: false },
    keysBySession: new Map(),
    keyOwners: new Map(),
  };
  return {
    name: "koi:circuit-breaker",
    priority: 175,
    phase: "intercept",
    wrapModelCall: (ctx, request, next) => cbWrapModelCall(state, ctx, request, next),
    wrapModelStream: (ctx, request, next) => cbWrapModelStream(state, ctx, request, next),
    onSessionEnd: async (ctx) => {
      evictSessionKeys(state, ctx.sessionId);
    },
    describeCapabilities: () => cbDescribe(state),
  } satisfies KoiMiddleware;
}
