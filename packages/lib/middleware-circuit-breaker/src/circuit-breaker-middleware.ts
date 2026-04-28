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
): AsyncIterable<ModelChunk> {
  try {
    for await (const chunk of source) {
      if (chunk.kind === "error") {
        const status = streamErrorStatus(chunk);
        if (status !== undefined) breaker.recordFailure(status);
        yield chunk;
        return;
      }
      if (chunk.kind === "done") {
        breaker.recordSuccess();
        yield chunk;
        return;
      }
      yield chunk;
    }
    // Iterator ended without an explicit terminal chunk — query-engine treats
    // this as an error ("stream ended without terminal chunk"). Count it as
    // a failure so degraded providers that produce truncated streams trip
    // the breaker instead of healing it. Pass no status so configured
    // failureStatusCodes filters can still suppress this if desired.
    breaker.recordFailure();
  } catch (err: unknown) {
    const status = extractStatusCode(err);
    if (status !== undefined) breaker.recordFailure(status);
    throw err;
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
  // Enforce maxKeys: evict the oldest insertion to bound memory. Keys are
  // caller-controlled (model strings or extractKey output), so an unbounded
  // map is a memory leak and a state-isolation problem under high cardinality.
  if (s.breakers.size >= s.maxKeys) {
    if (!s.warnGuard.warned) {
      s.warnGuard.warned = true;
      console.warn(
        `[circuit-breaker] key map reached ${String(s.maxKeys)} entries — evicting oldest; possible key explosion`,
      );
    }
    const oldest = s.breakers.keys().next().value;
    if (oldest !== undefined) s.breakers.delete(oldest);
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
  if (!breaker.isAllowed()) {
    return errorStream(createCircuitOpenError(key));
  }
  return trackedStream(next(request), breaker);
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
