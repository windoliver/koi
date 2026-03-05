/**
 * Main ModelRouter service — routes model calls across providers
 * with retry, fallback, cascade, and circuit breaker resilience.
 */

import type { KoiError, ModelRequest, ModelResponse, Result } from "@koi/core";
import { withCascade } from "./cascade/cascade.js";
import { createCascadeMetricsTracker } from "./cascade/cascade-metrics.js";
import type {
  CascadeClassifier,
  CascadeCostMetrics,
  CascadeEvaluator,
} from "./cascade/cascade-types.js";
import {
  type CircuitBreaker,
  type CircuitBreakerSnapshot,
  createCircuitBreaker,
} from "./circuit-breaker.js";
import type { ResolvedRouterConfig, ResolvedTargetConfig } from "./config.js";
import { type FallbackTarget, withFallback } from "./fallback.js";
import type { ProviderAdapter, StreamChunk } from "./provider-adapter.js";
import { withRetry } from "./retry.js";
import { createTargetOrderer } from "./target-ordering.js";

export interface RouterMetrics {
  readonly totalRequests: number;
  readonly totalFailures: number;
  readonly requestsByTarget: Readonly<Record<string, number>>;
  readonly failuresByTarget: Readonly<Record<string, number>>;
  readonly totalEstimatedCost: number;
  readonly cascade?: CascadeCostMetrics;
}

export interface ModelRouter {
  readonly route: (request: ModelRequest) => Promise<Result<ModelResponse, KoiError>>;
  readonly routeStream: (request: ModelRequest) => AsyncGenerator<StreamChunk>;
  readonly getHealth: () => ReadonlyMap<string, CircuitBreakerSnapshot>;
  readonly getMetrics: () => RouterMetrics;
  readonly dispose: () => void;
}

export interface ModelRouterOptions {
  readonly evaluator?: CascadeEvaluator;
  readonly classifier?: CascadeClassifier;
  readonly clock?: () => number;
  /** Injectable random for deterministic testing of weighted strategy. */
  readonly random?: () => number;
}

function targetId(t: ResolvedTargetConfig): string {
  return `${t.provider}:${t.model}`;
}

/**
 * Checks whether a URL is a local/loopback address.
 */
function isLocalUrl(url?: string): boolean {
  return (
    url !== undefined &&
    (url.includes("localhost") || url.includes("127.0.0.1") || url.includes("[::1]"))
  );
}

/**
 * Creates a model router with the given config and provider adapters.
 *
 * Eagerly validates config (fail fast). Lazily connects to providers (on first request).
 *
 * @param config - Resolved router configuration
 * @param adapters - Map of provider ID → ProviderAdapter
 * @param clockOrOptions - Injectable clock (deprecated) or options object
 */
export function createModelRouter(
  config: ResolvedRouterConfig,
  adapters: ReadonlyMap<string, ProviderAdapter>,
  clockOrOptions?: (() => number) | ModelRouterOptions,
): ModelRouter {
  // Support both legacy clock parameter and new options object
  const options: ModelRouterOptions =
    typeof clockOrOptions === "function" ? { clock: clockOrOptions } : (clockOrOptions ?? {});

  const clock = options.clock ?? Date.now;

  // Validate cascade requires evaluator
  if (config.strategy === "cascade" && !options.evaluator) {
    throw new Error(
      "Cascade strategy requires an evaluator. Pass { evaluator } in the options parameter.",
    );
  }

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

  // Target ordering for round-robin / weighted strategies
  const targetWeights = new Map(config.targets.map((t) => [targetId(t), t.weight]));
  const orderTargets = createTargetOrderer({
    strategy: config.strategy,
    weights: targetWeights,
    ...(options.random !== undefined ? { random: options.random } : {}),
  });

  // Create per-target circuit breakers
  const circuitBreakers = new Map<string, CircuitBreaker>();
  for (const t of fallbackTargets) {
    circuitBreakers.set(t.id, createCircuitBreaker(config.circuitBreaker, clock));
  }

  // Mutable metrics (encapsulated — justified per circuit-breaker.ts precedent:
  // internal mutation behind immutable public interface, single-threaded runtime)
  const requestsByTarget: Record<string, number> = {};
  const failuresByTarget: Record<string, number> = {};
  // let: perf counters, encapsulated behind immutable RouterMetrics
  let totalRequests = 0;
  let totalFailures = 0;
  let fallbackCostTotal = 0;

  // Cascade metrics tracking — wired to CascadeMetricsTracker
  const cascadeTracker =
    config.strategy === "cascade" && config.cascade
      ? createCascadeMetricsTracker(config.cascade.tiers)
      : undefined;

  // Health probe timer for local targets
  let healthProbeTimer: ReturnType<typeof setInterval> | undefined;

  if (config.healthProbe) {
    const intervalMs = config.healthProbe.intervalMs ?? 30_000;
    const onlyLocal = config.healthProbe.onlyLocal !== false;

    // Identify targets that support health checks
    const probeTargets = config.targets.filter((t) => {
      if (onlyLocal && !isLocalUrl(t.adapterConfig.baseUrl)) {
        return false;
      }
      const adapter = adapters.get(t.provider);
      return adapter?.checkHealth !== undefined;
    });

    if (probeTargets.length > 0) {
      const probe = async (): Promise<void> => {
        await Promise.allSettled(
          probeTargets.map(async (target) => {
            const id = targetId(target);
            const adapter = adapters.get(target.provider);
            const cb = circuitBreakers.get(id);
            if (!adapter?.checkHealth || !cb) return;

            try {
              const healthy = await adapter.checkHealth();
              if (healthy) {
                cb.recordSuccess();
              } else {
                cb.recordFailure();
              }
            } catch {
              cb.recordFailure();
            }
          }),
        );
      };

      // Initial probe
      void probe();
      healthProbeTimer = setInterval(probe, intervalMs);
    }
  }

  async function executeForTargetId(id: string, request: ModelRequest): Promise<ModelResponse> {
    const targetConfig = targetConfigById.get(id);
    if (!targetConfig) {
      throw {
        code: "NOT_FOUND",
        message: `Target config not found: ${id}`,
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
    requestsByTarget[id] = (requestsByTarget[id] ?? 0) + 1;

    const modelRequest: ModelRequest = {
      ...request,
      model: targetConfig.model,
    };

    try {
      return await withRetry(() => adapter.complete(modelRequest), config.retry, clock);
    } catch (error: unknown) {
      failuresByTarget[id] = (failuresByTarget[id] ?? 0) + 1;
      throw error;
    }
  }

  /**
   * Determines ordered target list for streaming, taking cascade
   * classification into account when available.
   */
  function getStreamTargets(request: ModelRequest): readonly FallbackTarget[] {
    if (config.strategy === "cascade" && config.cascade && options.classifier) {
      const allTiers = config.cascade.tiers;
      const classification = options.classifier(request, allTiers.length);
      const startIndex = classification.recommendedTierIndex;
      const tierTargets: readonly FallbackTarget[] = allTiers.slice(startIndex).map((t) => ({
        id: t.targetId,
        enabled: true,
      }));
      return tierTargets.length > 0 ? tierTargets : enabledFallbackTargets;
    }
    return orderTargets(enabledFallbackTargets);
  }

  /**
   * Checks whether a target can handle the features required by the request.
   * If the target has no declared capabilities, it is assumed to support everything
   * (fail-open to prevent false negatives).
   */
  function targetSupportsRequest(
    targetConfig: ResolvedTargetConfig,
    request: ModelRequest,
  ): boolean {
    const caps = targetConfig.capabilities;
    if (!caps) return true; // No capabilities declared → assume compatible

    // Check vision: if request contains image blocks, target needs vision
    const needsVision = request.messages.some((m) => m.content.some((b) => b.kind === "image"));
    if (needsVision && caps.vision === false) return false;

    return true;
  }

  return {
    async route(request: ModelRequest): Promise<Result<ModelResponse, KoiError>> {
      totalRequests++;

      if (config.strategy === "cascade" && config.cascade && options.evaluator) {
        // Pre-request classification: skip cheap tiers for complex requests
        const allTiers = config.cascade.tiers;
        const classification = options.classifier?.(request, allTiers.length);
        const classifiedTiers = classification
          ? allTiers.slice(classification.recommendedTierIndex)
          : allTiers;
        // Ensure at least one tier remains
        const tiers = classifiedTiers.length > 0 ? classifiedTiers : allTiers;

        const result = await withCascade(
          tiers,
          (tier) => executeForTargetId(tier.targetId, request),
          options.evaluator,
          config.cascade,
          circuitBreakers,
          request,
          clock,
        );

        if (!result.ok) {
          totalFailures++;
          return result;
        }

        // Record cascade metrics via tracker
        if (cascadeTracker) {
          for (const attempt of result.value.attempts) {
            if (attempt.success) {
              const tierResponse: ModelResponse = {
                content: result.value.response.content,
                model: result.value.response.model,
                ...(attempt.inputTokens !== undefined || attempt.outputTokens !== undefined
                  ? {
                      usage: {
                        inputTokens: attempt.inputTokens ?? 0,
                        outputTokens: attempt.outputTokens ?? 0,
                      },
                    }
                  : {}),
              };
              cascadeTracker.record(attempt.tierId, tierResponse, attempt.escalated);
            }
          }
        }

        return { ok: true, value: result.value.response };
      }

      const result = await withFallback(
        orderTargets(enabledFallbackTargets),
        (target) => executeForTargetId(target.id, request),
        circuitBreakers,
        clock,
      );

      if (!result.ok) {
        totalFailures++;
        return result;
      }

      // Accumulate fallback cost from target's cost config + usage
      const successAttempt = result.value.attempts.find((a) => a.success);
      const successTargetConfig = successAttempt
        ? targetConfigById.get(successAttempt.targetId)
        : undefined;
      const usage = result.value.value.usage;
      if (successTargetConfig && usage) {
        fallbackCostTotal +=
          (usage.inputTokens ?? 0) * (successTargetConfig.costPerInputToken ?? 0) +
          (usage.outputTokens ?? 0) * (successTargetConfig.costPerOutputToken ?? 0);
      }

      return { ok: true, value: result.value.value };
    },

    async *routeStream(request: ModelRequest): AsyncGenerator<StreamChunk> {
      const orderedTargets = getStreamTargets(request);
      const errors: KoiError[] = [];

      for (const target of orderedTargets) {
        const cb = circuitBreakers.get(target.id);
        if (cb && !cb.isAllowed()) continue;

        const targetConfig = targetConfigById.get(target.id);
        if (!targetConfig) continue;

        // Capability matching: skip incompatible targets
        if (!targetSupportsRequest(targetConfig, request)) continue;

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
      if (cascadeTracker) {
        const cascadeMetrics = cascadeTracker.getMetrics();
        return {
          totalRequests,
          totalFailures,
          requestsByTarget: { ...requestsByTarget },
          failuresByTarget: { ...failuresByTarget },
          totalEstimatedCost: cascadeMetrics.totalEstimatedCost,
          cascade: cascadeMetrics,
        };
      }

      return {
        totalRequests,
        totalFailures,
        requestsByTarget: { ...requestsByTarget },
        failuresByTarget: { ...failuresByTarget },
        totalEstimatedCost: fallbackCostTotal,
      };
    },

    dispose(): void {
      if (healthProbeTimer) {
        clearInterval(healthProbeTimer);
        healthProbeTimer = undefined;
      }
      for (const cb of circuitBreakers.values()) {
        cb.reset();
      }
    },
  };
}
