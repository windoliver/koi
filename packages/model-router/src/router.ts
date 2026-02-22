/**
 * Main ModelRouter service — routes model calls across providers
 * with retry, fallback, and circuit breaker resilience.
 */

import type { KoiError, ModelRequest, ModelResponse, Result } from "@koi/core";
import {
  type CircuitBreaker,
  type CircuitBreakerSnapshot,
  createCircuitBreaker,
} from "./circuit-breaker.js";
import type { ResolvedRouterConfig, ResolvedTargetConfig } from "./config.js";
import { type FallbackTarget, withFallback } from "./fallback.js";
import type { ProviderAdapter, StreamChunk } from "./provider-adapter.js";
import { withRetry } from "./retry.js";

export interface RouterMetrics {
  readonly totalRequests: number;
  readonly totalFailures: number;
  readonly requestsByTarget: Readonly<Record<string, number>>;
  readonly failuresByTarget: Readonly<Record<string, number>>;
}

export interface ModelRouter {
  readonly route: (request: ModelRequest) => Promise<Result<ModelResponse, KoiError>>;
  readonly routeStream: (request: ModelRequest) => AsyncGenerator<StreamChunk>;
  readonly getHealth: () => ReadonlyMap<string, CircuitBreakerSnapshot>;
  readonly getMetrics: () => RouterMetrics;
  readonly dispose: () => void;
}

function targetId(t: ResolvedTargetConfig): string {
  return `${t.provider}:${t.model}`;
}

/**
 * Creates a model router with the given config and provider adapters.
 *
 * Eagerly validates config (fail fast). Lazily connects to providers (on first request).
 *
 * @param config - Resolved router configuration
 * @param adapters - Map of provider ID → ProviderAdapter
 * @param clock - Injectable clock for deterministic testing
 */
export function createModelRouter(
  config: ResolvedRouterConfig,
  adapters: ReadonlyMap<string, ProviderAdapter>,
  clock: () => number = Date.now,
): ModelRouter {
  // Validate that all configured providers have adapters
  for (const target of config.targets) {
    if (!adapters.has(target.provider)) {
      throw new Error(
        `No adapter registered for provider "${target.provider}". ` +
          `Available: ${[...adapters.keys()].join(", ")}`,
      );
    }
  }

  // Precompute target lookups — O(1) per request instead of O(n) scans
  const targetConfigById = new Map<string, ResolvedTargetConfig>();
  for (const t of config.targets) {
    targetConfigById.set(targetId(t), t);
  }

  // Cached fallback targets — immutable after construction
  const fallbackTargets: readonly FallbackTarget[] = config.targets.map((t) => ({
    id: targetId(t),
    enabled: t.enabled,
  }));

  const enabledFallbackTargets: readonly FallbackTarget[] = fallbackTargets.filter(
    (t) => t.enabled,
  );

  // Create per-target circuit breakers
  const circuitBreakers = new Map<string, CircuitBreaker>();
  for (const t of fallbackTargets) {
    circuitBreakers.set(t.id, createCircuitBreaker(config.circuitBreaker, clock));
  }

  // Mutable metrics (encapsulated)
  const requestsByTarget: Record<string, number> = {};
  const failuresByTarget: Record<string, number> = {};
  let totalRequests = 0;
  let totalFailures = 0;

  async function executeForTarget(
    target: FallbackTarget,
    request: ModelRequest,
  ): Promise<ModelResponse> {
    const targetConfig = targetConfigById.get(target.id);
    if (!targetConfig) {
      throw {
        code: "NOT_FOUND",
        message: `Target config not found: ${target.id}`,
        retryable: false,
      } satisfies KoiError;
    }

    const adapter = adapters.get(targetConfig.provider);
    if (!adapter) {
      throw {
        code: "NOT_FOUND",
        message: `Adapter not found: ${targetConfig.provider}`,
        retryable: false,
      } satisfies KoiError;
    }

    // Track metrics
    requestsByTarget[target.id] = (requestsByTarget[target.id] ?? 0) + 1;

    const modelRequest: ModelRequest = {
      ...request,
      model: targetConfig.model,
    };

    return withRetry(() => adapter.complete(modelRequest), config.retry, clock);
  }

  return {
    async route(request: ModelRequest): Promise<Result<ModelResponse, KoiError>> {
      totalRequests++;

      const result = await withFallback(
        fallbackTargets,
        (target) => executeForTarget(target, request),
        circuitBreakers,
        clock,
      );

      if (!result.ok) {
        totalFailures++;
        return result;
      }

      return { ok: true, value: result.value.value };
    },

    async *routeStream(request: ModelRequest): AsyncGenerator<StreamChunk> {
      const errors: KoiError[] = [];

      for (const target of enabledFallbackTargets) {
        const cb = circuitBreakers.get(target.id);
        if (cb && !cb.isAllowed()) continue;

        const targetConfig = targetConfigById.get(target.id);
        if (!targetConfig) continue;

        const adapter = adapters.get(targetConfig.provider);
        if (!adapter) continue;

        const modelRequest: ModelRequest = { ...request, model: targetConfig.model };

        try {
          const stream = adapter.stream(modelRequest);
          for await (const chunk of stream) {
            yield chunk;
          }
          cb?.recordSuccess();
          return;
        } catch (error: unknown) {
          cb?.recordFailure();
          const koiError: KoiError = {
            code: "EXTERNAL",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
            cause: error,
          };
          errors.push(koiError);
        }
      }

      // All targets failed
      yield {
        kind: "error",
        message: `All streaming targets failed: ${errors.map((e) => e.message).join("; ")}`,
      };
    },

    getHealth(): ReadonlyMap<string, CircuitBreakerSnapshot> {
      const health = new Map<string, CircuitBreakerSnapshot>();
      for (const [id, cb] of circuitBreakers) {
        health.set(id, cb.getSnapshot());
      }
      return health;
    },

    getMetrics(): RouterMetrics {
      return {
        totalRequests,
        totalFailures,
        requestsByTarget: { ...requestsByTarget },
        failuresByTarget: { ...failuresByTarget },
      };
    },

    dispose(): void {
      for (const cb of circuitBreakers.values()) {
        cb.reset();
      }
    },
  };
}
