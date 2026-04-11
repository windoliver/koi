/**
 * createModelRouter — thin assembly function.
 *
 * Wires config, adapters, circuit breakers, metrics, health probe,
 * in-flight cache, and ordering strategy together. All heavy logic
 * lives in dedicated modules (fallback, route-core, health-probe, etc.).
 */

import type { KoiError, ModelChunk, ModelRequest, ModelResponse, Result } from "@koi/core";
import {
  type CircuitBreaker,
  type CircuitBreakerSnapshot,
  createCircuitBreaker,
} from "@koi/errors";
import type { ResolvedRouterConfig, RouterMetrics, TargetMetrics } from "./config.js";
import { type FallbackTarget, withFallback } from "./fallback.js";
import { createHealthProbe } from "./health-probe.js";
import { createInFlightCache } from "./in-flight-cache.js";
import { createLatencyTracker, type LatencyTracker } from "./latency-tracker.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import { executeForTarget, targetSupportsRequest } from "./route-core.js";
import { createTargetOrderer } from "./target-ordering.js";

/**
 * Routing decision metadata emitted after every model call.
 * Surfaced in ATIF trajectory via ctx.reportDecision → metadata.decisions.
 */
export interface RouteDecision {
  /** Target ID (provider:model) that served the request. Empty string if all targets failed. */
  readonly selectedTargetId: string;
  /** All target IDs attempted in order (includes failures). */
  readonly attemptedTargetIds: readonly string[];
  /** True if any target failed before the successful one was reached. */
  readonly fallbackOccurred: boolean;
}

/** Successful route result — response plus routing metadata. */
export interface RouteSuccess {
  readonly response: ModelResponse;
  readonly decision: RouteDecision;
}

export interface ModelRouter {
  readonly route: (request: ModelRequest) => Promise<Result<RouteSuccess, KoiError>>;
  /**
   * onDecision is called once per stream: on first chunk (success path) or after
   * all targets exhausted (failure path). Always called before the error chunk.
   */
  readonly routeStream: (
    request: ModelRequest,
    onDecision?: (decision: RouteDecision) => void,
  ) => AsyncIterable<ModelChunk>;
  readonly getHealth: () => ReadonlyMap<string, CircuitBreakerSnapshot>;
  readonly getMetrics: () => RouterMetrics;
  readonly dispose: () => void;
}

export interface ModelRouterOptions {
  /** Injectable clock for deterministic testing. Defaults to Date.now. */
  readonly clock?: (() => number) | undefined;
  /** Injectable setInterval for health probe testing. Defaults to globalThis.setInterval. */
  readonly setInterval?: typeof globalThis.setInterval | undefined;
  /** Injectable random for deterministic weighted-strategy testing. */
  readonly random?: (() => number) | undefined;
}

function targetId(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/**
 * Creates a model router with the given config and provider adapters.
 *
 * Eagerly validates that all configured providers have adapters (fail fast).
 * Lazily connects to providers on first request.
 */
export function createModelRouter(
  config: ResolvedRouterConfig,
  adapters: ReadonlyMap<string, ProviderAdapter>,
  options: ModelRouterOptions = {},
): ModelRouter {
  const clock = options.clock ?? Date.now;

  // Validate all configured providers have adapters
  for (const target of config.targets) {
    if (!adapters.has(target.provider)) {
      throw new Error(
        `No adapter registered for provider "${target.provider}". ` +
          `Available: ${[...adapters.keys()].join(", ")}`,
      );
    }
  }

  // Build O(1) lookups — immutable after construction
  const targetConfigById = new Map(config.targets.map((t) => [targetId(t.provider, t.model), t]));

  const allFallbackTargets: readonly FallbackTarget[] = config.targets.map((t) => ({
    id: targetId(t.provider, t.model),
    enabled: t.enabled,
  }));

  const enabledFallbackTargets = allFallbackTargets.filter((t) => t.enabled);

  const targetWeights = new Map(
    config.targets.map((t) => [targetId(t.provider, t.model), t.weight]),
  );

  const orderTargets = createTargetOrderer({
    strategy: config.strategy,
    weights: targetWeights,
    ...(options.random !== undefined ? { random: options.random } : {}),
  });

  // Per-target circuit breakers
  const circuitBreakers = new Map<string, CircuitBreaker>(
    allFallbackTargets.map((t) => [t.id, createCircuitBreaker(config.circuitBreaker, clock)]),
  );

  // Per-target latency trackers
  const latencyTrackers = new Map<string, LatencyTracker>(
    allFallbackTargets.map((t) => [t.id, createLatencyTracker()]),
  );

  // Mutable metrics counters — encapsulated behind RouterMetrics snapshot
  const requestsByTarget: Record<string, number> = {};
  const failuresByTarget: Record<string, number> = {};
  const lastErrorAtByTarget: Record<string, number> = {};
  // let: total counters, justified — single-threaded, encapsulated mutation
  let totalRequests = 0;
  let totalFailures = 0;
  let totalEstimatedCost = 0;

  const inFlightCache = createInFlightCache<RouteSuccess>();

  // Health probe (local providers only)
  const probe = config.healthProbe
    ? createHealthProbe({
        intervalMs: config.healthProbe.intervalMs ?? 30_000,
        setInterval: options.setInterval,
        targets: config.targets
          .filter((t) => adapters.get(t.provider)?.checkHealth !== undefined)
          .flatMap((t) => {
            const adapter = adapters.get(t.provider);
            const id = targetId(t.provider, t.model);
            const cb = circuitBreakers.get(id);
            if (adapter === undefined || cb === undefined) return [];
            return [{ id, adapter, circuitBreaker: cb, baseUrl: t.adapterConfig.baseUrl }];
          }),
      })
    : undefined;

  const routeCtx = {
    adapters,
    targetConfigById,
    latencyTrackers,
    requestsByTarget,
    failuresByTarget,
    retryConfig: config.retry,
    clock,
  };

  function getCompatibleTargets(request: ModelRequest): readonly FallbackTarget[] {
    const compatible = enabledFallbackTargets.filter((t) => {
      const cfg = targetConfigById.get(t.id);
      return cfg !== undefined && targetSupportsRequest(cfg, request);
    });
    return compatible.length > 0 ? compatible : enabledFallbackTargets;
  }

  function accumulateCost(id: string, response: ModelResponse): void {
    const cfg = targetConfigById.get(id);
    const usage = response.usage;
    if (cfg === undefined || usage === undefined) return;
    totalEstimatedCost +=
      (usage.inputTokens ?? 0) * (cfg.costPerInputToken ?? 0) +
      (usage.outputTokens ?? 0) * (cfg.costPerOutputToken ?? 0);
  }

  return {
    async route(request: ModelRequest): Promise<Result<RouteSuccess, KoiError>> {
      totalRequests++;

      const result = await inFlightCache
        .getOrExecute(request, async () => {
          const ordered = orderTargets(getCompatibleTargets(request));
          const fallbackResult = await withFallback(
            ordered,
            (target) => executeForTarget(target.id, request, routeCtx),
            circuitBreakers,
            clock,
          );
          if (!fallbackResult.ok) throw fallbackResult.error;

          const { value: response, attempts } = fallbackResult.value;
          const successAttempt = attempts.find((a) => a.success);
          const attemptedTargetIds = attempts.map((a) => a.targetId);

          const decision: RouteDecision = {
            selectedTargetId: successAttempt?.targetId ?? "",
            attemptedTargetIds,
            fallbackOccurred: attempts.some((a) => !a.success),
          };

          return { response, decision } satisfies RouteSuccess;
        })
        .then(
          (value): Result<RouteSuccess, KoiError> => ({ ok: true, value }),
          (error: unknown): Result<RouteSuccess, KoiError> => ({
            ok: false,
            error: error as KoiError,
          }),
        );

      if (!result.ok) {
        totalFailures++;
        return result;
      }

      accumulateCost(result.value.decision.selectedTargetId, result.value.response);
      return result;
    },

    async *routeStream(
      request: ModelRequest,
      onDecision?: (decision: RouteDecision) => void,
    ): AsyncIterable<ModelChunk> {
      const orderedTargets = orderTargets(getCompatibleTargets(request));
      const attempted: string[] = [];

      for (const target of orderedTargets) {
        const cb = circuitBreakers.get(target.id);
        if (cb !== undefined && !cb.isAllowed()) continue;

        const targetConfig = targetConfigById.get(target.id);
        if (targetConfig === undefined) continue;
        if (!targetSupportsRequest(targetConfig, request)) continue;

        const adapter = adapters.get(targetConfig.provider);
        if (adapter === undefined) continue;

        attempted.push(target.id);
        const modelRequest: ModelRequest = { ...request, model: targetConfig.model };

        // Track whether any chunks have been yielded.
        // If the stream fails mid-response, do NOT fall through to the next provider —
        // that would splice two partial responses, corrupting the caller's stream.
        let chunksYielded = false;
        const startMs = clock();

        try {
          const stream = adapter.stream(modelRequest);
          for await (const chunk of stream) {
            if (!chunksYielded) {
              // Emit decision on first chunk — we now know which target is serving
              onDecision?.({
                selectedTargetId: target.id,
                attemptedTargetIds: [...attempted],
                fallbackOccurred: attempted.length > 1,
              });
            }
            chunksYielded = true;
            yield chunk;
          }
          cb?.recordSuccess();
          latencyTrackers.get(target.id)?.record(clock() - startMs);
          return;
        } catch (error: unknown) {
          cb?.recordFailure();
          lastErrorAtByTarget[target.id] = clock();
          failuresByTarget[target.id] = (failuresByTarget[target.id] ?? 0) + 1;

          if (chunksYielded) {
            // Mid-stream failure: propagate, never switch providers
            throw error;
          }
          // Pre-first-chunk failure: try next target
        }
      }

      // All targets exhausted — emit decision before error chunk
      onDecision?.({
        selectedTargetId: "",
        attemptedTargetIds: [...attempted],
        fallbackOccurred: attempted.length > 1,
      });

      const errorChunk: ModelChunk = {
        kind: "error",
        message: "All streaming targets failed",
        retryable: false,
      };
      yield errorChunk;
    },

    getHealth(): ReadonlyMap<string, CircuitBreakerSnapshot> {
      const health = new Map<string, CircuitBreakerSnapshot>();
      for (const [id, cb] of circuitBreakers) {
        health.set(id, cb.getSnapshot());
      }
      return health;
    },

    getMetrics(): RouterMetrics {
      const byTarget = new Map<string, TargetMetrics>();
      for (const [id] of allFallbackTargets.map((t) => [t.id, t] as const)) {
        const percentiles = latencyTrackers.get(id)?.getPercentiles();
        byTarget.set(id, {
          requests: requestsByTarget[id] ?? 0,
          failures: failuresByTarget[id] ?? 0,
          p50Ms: percentiles?.p50Ms,
          p95Ms: percentiles?.p95Ms,
          lastErrorAt: lastErrorAtByTarget[id],
        });
      }
      return {
        totalRequests,
        totalFailures,
        byTarget,
        totalEstimatedCost,
      };
    },

    dispose(): void {
      probe?.dispose();
      for (const cb of circuitBreakers.values()) {
        cb.reset();
      }
    },
  };
}
