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

function defaultExtractKey(model: string | undefined): string {
  if (model === undefined || model.length === 0) return "default";
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : model;
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
    // broke. That's an upstream truncation — count it as a failure.
    consumerCancelled = false;
    breaker.recordFailure();
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
      breaker.recordFailure();
    }
  }
}

interface CbState {
  readonly breakerConfig: CircuitBreakerConfig;
  readonly extractKey: (model: string | undefined) => string;
  readonly maxKeys: number;
  readonly clock: (() => number) | undefined;
  readonly breakers: Map<string, CircuitBreaker>;
  readonly warnGuard: { warned: boolean };
}

function getOrCreateBreaker(s: CbState, key: string): CircuitBreaker {
  const existing = s.breakers.get(key);
  if (existing !== undefined) return existing;
  // Enforce maxKeys: evict the oldest CLOSED entry to bound memory. Keys
  // are caller-controlled (model strings or extractKey output), so an
  // unbounded map is a memory leak and a state-isolation problem under
  // high cardinality. We MUST NOT evict OPEN/HALF_OPEN circuits — that
  // would silently reset a tripped breaker and resume sending traffic to
  // a still-unhealthy provider, defeating fail-fast exactly during the
  // high-cardinality incidents this guard exists to handle.
  if (s.breakers.size >= s.maxKeys) {
    if (!s.warnGuard.warned) {
      s.warnGuard.warned = true;
      console.warn(
        `[circuit-breaker] key map reached ${String(s.maxKeys)} entries — evicting oldest CLOSED; possible key explosion`,
      );
    }
    for (const [k, b] of s.breakers) {
      if (b.getSnapshot().state === "CLOSED") {
        s.breakers.delete(k);
        break;
      }
    }
    // If every entry is OPEN/HALF_OPEN we accept temporary overshoot
    // rather than reset an active breaker. Memory is bounded by incident
    // duration in that pathological case.
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
  request: ModelRequest,
  next: ModelHandler,
): Promise<ModelResponse> {
  const key = s.extractKey(request.model);
  const breaker = getOrCreateBreaker(s, key);
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
  request: ModelRequest,
  next: ModelStreamHandler,
): AsyncIterable<ModelChunk> {
  const key = s.extractKey(request.model);
  const breaker = getOrCreateBreaker(s, key);
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
  return trackedStream(next(request), breaker, tookProbe);
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
  };
  return {
    name: "koi:circuit-breaker",
    priority: 175,
    phase: "intercept",
    wrapModelCall: (_ctx: TurnContext, request, next) => cbWrapModelCall(state, request, next),
    wrapModelStream: (_ctx: TurnContext, request, next) => cbWrapModelStream(state, request, next),
    describeCapabilities: () => cbDescribe(state),
  } satisfies KoiMiddleware;
}
