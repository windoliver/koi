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
import { createCircuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@koi/errors";
import { createRoundRobinState, executeWithFailover } from "@koi/variant-selection";
import { buildVariantPools } from "./build-pools.js";
import type {
  DegenerateHandle,
  DegenerateMiddlewareConfig,
  DegenerateSessionState,
} from "./types.js";

/** Creates a degenerate middleware with variant selection and failover. */
export function createDegenerateMiddleware(config: DegenerateMiddlewareConfig): DegenerateHandle {
  const clock = config.clock ?? Date.now;
  const random = config.random ?? Math.random;
  const cbConfig = config.circuitBreakerConfig ?? DEFAULT_CIRCUIT_BREAKER_CONFIG;

  // Per-session state keyed by session ID
  const sessions = new Map<string, DegenerateSessionState>();

  function initBreakers(state: DegenerateSessionState): void {
    for (const [, pool] of state.pools) {
      for (const variant of pool.variants) {
        if (!state.breakers.has(variant.id)) {
          state.breakers.set(variant.id, createCircuitBreaker(cbConfig, clock));
        }
      }
    }
  }

  function logAttempts(
    state: DegenerateSessionState,
    capability: string,
    attempts: readonly VariantAttempt[],
  ): void {
    const existing = state.attemptLog.get(capability) ?? [];
    state.attemptLog.set(capability, [...existing, ...attempts]);
  }

  /** Resolve session state by explicit ID or fall back to the sole active session. */
  function resolveState(sessionId?: string): DegenerateSessionState | undefined {
    if (sessionId !== undefined) {
      return sessions.get(sessionId);
    }
    // Fallback: if exactly one session is active, use it
    if (sessions.size === 1) {
      return sessions.values().next().value as DegenerateSessionState;
    }
    return undefined;
  }

  const middleware: KoiMiddleware = {
    name: "degenerate",
    priority: 460,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      const result = await buildVariantPools({
        forgeStore: config.forgeStore,
        capabilityConfigs: config.capabilityConfigs,
        createToolExecutor: config.createToolExecutor,
        clock,
      });
      const state: DegenerateSessionState = {
        pools: new Map(result.pools),
        toolToCapability: new Map(result.toolToCapability),
        breakers: new Map(),
        roundRobinStates: new Map(),
        attemptLog: new Map(),
      };
      initBreakers(state);
      sessions.set(ctx.sessionId as string, state);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const sid = ctx.sessionId as string;
      const state = sessions.get(sid);
      if (state === undefined) return;
      // Dispose circuit breakers
      for (const [, breaker] of state.breakers) {
        breaker.reset();
      }
      sessions.delete(sid);
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (state === undefined) {
        // No session state — pass through
        return next(request);
      }

      // Look up which capability this tool belongs to
      const capability = state.toolToCapability.get(request.toolId);
      if (capability === undefined) {
        // Not a degenerate tool — pass through
        return next(request);
      }

      const pool = state.pools.get(capability);
      if (pool === undefined || pool.variants.length === 0) {
        // No variants available — pass through
        return next(request);
      }

      const strategy = pool.config.selectionStrategy;

      // Get or create round-robin state for this capability
      let rrState = state.roundRobinStates.get(capability);
      if (rrState === undefined) {
        rrState = createRoundRobinState();
        state.roundRobinStates.set(capability, rrState);
      }

      const outcome = await executeWithFailover({
        pool,
        breakers: state.breakers,
        selectOptions: {
          strategy,
          ctx: { input: request.input, clock, random },
          roundRobinState: rrState,
        },
        execute: async (variant) => {
          // Use the middleware chain (next) when the selected variant IS the
          // tool the model actually called; otherwise route through next with
          // the variant's tool ID so failover paths also traverse the chain.
          if (variant.id === request.toolId) {
            return next(request);
          }
          return next({ ...request, toolId: variant.id });
        },
        clock,
      });

      // Log attempts
      const attempts = outcome.ok ? outcome.value.attempts : outcome.attempts;
      logAttempts(state, capability, attempts);

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

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      const state = sessions.get(ctx.session.sessionId as string);
      if (state === undefined || state.pools.size === 0) return undefined;
      const totalVariants = [...state.pools.values()].reduce(
        (sum, p) => sum + p.variants.length,
        0,
      );
      return {
        label: "degeneracy",
        description: `${String(state.pools.size)} capabilities with ${String(totalVariants)} degenerate variants`,
      };
    },
  };

  return {
    middleware,
    getVariantPool: (capability: string, sessionId?: string) => {
      const state = resolveState(sessionId);
      return state?.pools.get(capability);
    },
    getAttemptLog: (capability: string, sessionId?: string): readonly VariantAttempt[] => {
      const state = resolveState(sessionId);
      return state?.attemptLog.get(capability) ?? [];
    },
  };
}
