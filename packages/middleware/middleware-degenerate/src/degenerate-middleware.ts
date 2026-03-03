/**
 * Middleware factory — creates the degenerate variant selection middleware.
 *
 * Intercepts tool calls for capabilities that have multiple degenerate variants.
 * Selects the primary variant and handles failover on failure.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
  VariantAttempt,
} from "@koi/core";
import {
  type CircuitBreaker,
  createCircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "@koi/errors";
import {
  createRoundRobinState,
  executeWithFailover,
  type RoundRobinState,
  type VariantPool,
} from "@koi/variant-selection";
import { buildVariantPools } from "./build-pools.js";
import type { DegenerateHandle, DegenerateMiddlewareConfig } from "./types.js";

/** Creates a degenerate middleware with variant selection and failover. */
export function createDegenerateMiddleware(config: DegenerateMiddlewareConfig): DegenerateHandle {
  const clock = config.clock ?? Date.now;
  const random = config.random ?? Math.random;
  const cbConfig = config.circuitBreakerConfig ?? DEFAULT_CIRCUIT_BREAKER_CONFIG;

  // Mutable internal state — initialized in onSessionStart
  let pools = new Map<string, VariantPool<ToolHandler>>();
  let toolToCapability = new Map<string, string>();
  let breakers = new Map<string, CircuitBreaker>();
  let roundRobinStates = new Map<string, RoundRobinState>();
  let attemptLog = new Map<string, VariantAttempt[]>();

  function initBreakers(): void {
    breakers = new Map();
    for (const [, pool] of pools) {
      for (const variant of pool.variants) {
        if (!breakers.has(variant.id)) {
          breakers.set(variant.id, createCircuitBreaker(cbConfig, clock));
        }
      }
    }
  }

  function logAttempts(capability: string, attempts: readonly VariantAttempt[]): void {
    const existing = attemptLog.get(capability) ?? [];
    attemptLog.set(capability, [...existing, ...attempts]);
  }

  const middleware: KoiMiddleware = {
    name: "degenerate",
    priority: 460,

    async onSessionStart(_ctx: SessionContext): Promise<void> {
      const result = await buildVariantPools({
        forgeStore: config.forgeStore,
        capabilityConfigs: config.capabilityConfigs,
        createToolExecutor: config.createToolExecutor,
        clock,
      });
      pools = new Map(result.pools);
      toolToCapability = new Map(result.toolToCapability);
      initBreakers();
      roundRobinStates = new Map();
      attemptLog = new Map();
    },

    async onSessionEnd(_ctx: SessionContext): Promise<void> {
      // Dispose circuit breakers and clear pools
      for (const [, breaker] of breakers) {
        breaker.reset();
      }
      pools.clear();
      toolToCapability.clear();
      breakers.clear();
      roundRobinStates.clear();
      attemptLog.clear();
    },

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      // Look up which capability this tool belongs to
      const capability = toolToCapability.get(request.toolId);
      if (capability === undefined) {
        // Not a degenerate tool — pass through
        return next(request);
      }

      const pool = pools.get(capability);
      if (pool === undefined || pool.variants.length === 0) {
        // No variants available — pass through
        return next(request);
      }

      const strategy = pool.config.selectionStrategy;

      // Get or create round-robin state for this capability
      let rrState = roundRobinStates.get(capability);
      if (rrState === undefined) {
        rrState = createRoundRobinState();
        roundRobinStates.set(capability, rrState);
      }

      const outcome = await executeWithFailover({
        pool,
        breakers,
        selectOptions: {
          strategy,
          ctx: { input: request.input, clock, random },
          roundRobinState: rrState,
        },
        execute: async (variant) => {
          // For the variant matching the current tool, use the normal middleware chain
          const currentToolVariant = pool.variants.find((v) => v.id === variant.id);
          if (currentToolVariant !== undefined) {
            // Check if this is the tool the LLM actually called
            // If so, use `next()` to preserve the middleware chain
            // Otherwise, call the variant's handler directly
            const isCalledTool =
              toolToCapability.get(request.toolId) === capability &&
              pool.variants[0]?.id === variant.id;
            if (isCalledTool) {
              return next(request);
            }
          }
          // Alternative variant — call handler directly (bypasses component map)
          return variant.value(request);
        },
        clock,
      });

      // Log attempts
      const attempts = outcome.ok ? outcome.value.attempts : outcome.attempts;
      logAttempts(capability, attempts);

      // Fire callbacks for failover events
      if (outcome.ok && outcome.value.attempts.length > 1) {
        for (let i = 0; i < outcome.value.attempts.length - 1; i++) {
          const attempt = outcome.value.attempts[i];
          const nextAttempt = outcome.value.attempts[i + 1];
          if (attempt !== undefined && !attempt.success && nextAttempt !== undefined) {
            config.onFailover?.(attempt, nextAttempt.variantId);
          }
        }
      }

      if (!outcome.ok) {
        config.onAllVariantsFailed?.(capability, outcome.attempts);
        // Re-throw the last error
        throw outcome.lastError;
      }

      // Attach attempt metadata to response
      return {
        ...outcome.value.result,
        metadata: {
          ...outcome.value.result.metadata,
          degenerateAttempts: outcome.value.attempts,
          selectedVariantId: outcome.value.selectedVariantId,
        },
      };
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      if (pools.size === 0) return undefined;
      const totalVariants = [...pools.values()].reduce((sum, p) => sum + p.variants.length, 0);
      return {
        label: "degeneracy",
        description: `${String(pools.size)} capabilities with ${String(totalVariants)} degenerate variants`,
      };
    },
  };

  return {
    middleware,
    getVariantPool: (capability: string): VariantPool<ToolHandler> | undefined =>
      pools.get(capability),
    getAttemptLog: (capability: string): readonly VariantAttempt[] =>
      attemptLog.get(capability) ?? [],
  };
}
