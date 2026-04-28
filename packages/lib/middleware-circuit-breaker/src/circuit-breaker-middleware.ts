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

function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as Record<string, unknown>;
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.code === "string") {
    if (e.code === "RATE_LIMIT") return 429;
    if (e.code === "TIMEOUT") return 503;
    if (e.code === "EXTERNAL") return 502;
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

async function* trackedStream(
  source: AsyncIterable<ModelChunk>,
  breaker: CircuitBreaker,
): AsyncIterable<ModelChunk> {
  try {
    for await (const chunk of source) {
      if (chunk.kind === "error") {
        breaker.recordFailure();
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
    breaker.recordSuccess();
  } catch (err: unknown) {
    breaker.recordFailure(extractStatusCode(err));
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
  if (!s.warnGuard.warned && s.breakers.size >= s.maxKeys) {
    s.warnGuard.warned = true;
    console.warn(
      `[circuit-breaker] key map reached ${String(s.breakers.size)} entries — possible key explosion`,
    );
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
    breaker.recordFailure(extractStatusCode(err));
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
