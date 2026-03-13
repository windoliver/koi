/**
 * Circuit breaker middleware — per-provider fail-fast with optional model fallback.
 *
 * Priority 175 (runs after prompt cache but before most business logic middleware).
 * Phase: "intercept" (blocks requests to unhealthy providers).
 *
 * Maintains a Map<provider, CircuitBreaker> keyed by the provider prefix
 * extracted from request.model. When a provider's circuit opens, requests
 * either fail fast or route to the configured fallback model.
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
import { extractProvider } from "@koi/name-resolution";
import type {
  CircuitBreakerMiddlewareConfig,
  ResolvedCircuitBreakerMiddlewareConfig,
} from "./types.js";

const DEFAULT_MAX_PROVIDER_ENTRIES = 50;

function resolveConfig(
  config?: CircuitBreakerMiddlewareConfig,
): ResolvedCircuitBreakerMiddlewareConfig {
  const breakerConfig: CircuitBreakerConfig = {
    ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
    ...config?.breaker,
  };
  return {
    breaker: breakerConfig,
    maxProviderEntries: config?.maxProviderEntries ?? DEFAULT_MAX_PROVIDER_ENTRIES,
  };
}

/**
 * Extract an HTTP-like status code from a caught error.
 * Supports common patterns: { status }, { statusCode }, KoiError.code mapping.
 */
function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  // Direct status field (fetch errors, Anthropic SDK)
  if ("status" in error && typeof (error as Record<string, unknown>).status === "number") {
    return (error as Record<string, unknown>).status as number;
  }

  // statusCode field (some HTTP libraries)
  if ("statusCode" in error && typeof (error as Record<string, unknown>).statusCode === "number") {
    return (error as Record<string, unknown>).statusCode as number;
  }

  // KoiError code mapping
  if ("code" in error) {
    const code = (error as KoiError).code;
    if (code === "RATE_LIMIT") return 429;
    if (code === "TIMEOUT") return 503;
    if (code === "EXTERNAL") return 502;
  }

  return undefined;
}

/**
 * Create a circuit breaker middleware.
 *
 * Maintains per-provider circuit breaker state. When a provider accumulates
 * too many failures, the circuit opens and subsequent requests either fail
 * fast with a RATE_LIMIT error or route to the configured fallback model.
 */
export function createCircuitBreakerMiddleware(
  config?: CircuitBreakerMiddlewareConfig,
): KoiMiddleware {
  const resolved = resolveConfig(config);

  // Per-provider circuit breakers (mutable Map — internal state, not shared)
  const breakers = new Map<string, CircuitBreaker>();
  let warnedMapSize = false; // let: one-shot warning guard

  function getBreaker(provider: string): CircuitBreaker {
    let breaker = breakers.get(provider);
    if (breaker === undefined) {
      // Defensive: warn if map grows unexpectedly
      if (!warnedMapSize && breakers.size >= resolved.maxProviderEntries) {
        warnedMapSize = true;
        // eslint-disable-next-line no-console -- one-shot diagnostic warning
        console.warn(
          `[circuit-breaker] Provider map has ${String(breakers.size)} entries — possible key extraction bug`,
        );
      }
      breaker = createCircuitBreaker(resolved.breaker);
      breakers.set(provider, breaker);
    }
    return breaker;
  }

  function getProviderFromModel(model: string | undefined): string {
    const provider = extractProvider(model ?? "");
    return provider.length > 0 ? provider : "default";
  }

  function createCircuitOpenError(provider: string): KoiError {
    return {
      code: "RATE_LIMIT",
      message: `Circuit breaker open for provider "${provider}" — too many consecutive failures`,
      retryable: true,
      context: { provider },
    };
  }

  return {
    name: "circuit-breaker",
    priority: 175,
    phase: "intercept",

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const provider = getProviderFromModel(request.model);
      const breaker = getBreaker(provider);

      if (!breaker.isAllowed()) {
        // Circuit open — fail fast. The model-router handles provider
        // failover via its own target ordering; rewriting request.model
        // here would be ignored since the router overwrites it anyway.
        throw createCircuitOpenError(provider);
      }

      try {
        const response = await next(request);
        breaker.recordSuccess();
        return response;
      } catch (error: unknown) {
        breaker.recordFailure(extractStatusCode(error));
        throw error;
      }
    },

    wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const provider = getProviderFromModel(request.model);
      const breaker = getBreaker(provider);

      if (!breaker.isAllowed()) {
        return errorStream(createCircuitOpenError(provider));
      }

      return wrapStreamWithTracking(next(request), breaker);
    },

    describeCapabilities(): CapabilityFragment | undefined {
      const openProviders: string[] = [];
      for (const [provider, breaker] of breakers) {
        const snap = breaker.getSnapshot();
        if (snap.state === "OPEN") {
          openProviders.push(provider);
        }
      }

      if (openProviders.length === 0) {
        return {
          label: "circuit-breaker",
          description: "All provider circuits closed (healthy).",
        };
      }

      return {
        label: "circuit-breaker",
        description: `Circuit open for: ${openProviders.join(", ")}. Model-router handles failover.`,
      };
    },
  } satisfies KoiMiddleware;
}

/**
 * Wrap an async iterable stream with circuit breaker success/failure tracking.
 * Records success on "done" chunk, failure on "error" chunk.
 */
async function* wrapStreamWithTracking(
  stream: AsyncIterable<ModelChunk>,
  breaker: CircuitBreaker,
): AsyncIterable<ModelChunk> {
  try {
    for await (const chunk of stream) {
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
    // Stream ended without done/error — treat as success
    breaker.recordSuccess();
  } catch (error: unknown) {
    breaker.recordFailure(extractStatusCode(error));
    throw error;
  }
}

/**
 * Create an async iterable that yields a single error chunk.
 */
async function* errorStream(error: KoiError): AsyncIterable<ModelChunk> {
  yield { kind: "error", message: error.message };
}
