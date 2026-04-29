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
  type CircuitBreakerConfig,
  createCircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  KoiRuntimeError,
} from "@koi/errors";
import {
  createRoundRobinState,
  createThompsonState,
  executeWithFailover,
  type ThompsonState,
  updateThompson,
  type VariantPool,
} from "@koi/variant-selection";
import { buildVariantPools } from "./build-pools.js";
import { validateDegenerateConfig } from "./config.js";
import type {
  DegenerateHandle,
  DegenerateMiddlewareConfig,
  DegenerateSessionState,
} from "./types.js";

function initBreakers(
  state: DegenerateSessionState,
  cbConfig: CircuitBreakerConfig,
  clock: () => number,
): void {
  for (const [, pool] of state.pools) {
    for (const variant of pool.variants) {
      if (!state.breakers.has(variant.id)) {
        state.breakers.set(variant.id, createCircuitBreaker(cbConfig, clock));
      }
    }
  }
}

/** Cap on retained attempts per capability — full history goes to the
 *  onFailover/onAllVariantsFailed callbacks; in-process state keeps only
 *  the recent window so long-lived sessions don't grow unbounded. */
const ATTEMPT_LOG_CAP = 256;

function logAttempts(
  state: DegenerateSessionState,
  capability: string,
  attempts: readonly VariantAttempt[],
): void {
  const existing = state.attemptLog.get(capability);
  if (existing === undefined) {
    state.attemptLog.set(
      capability,
      attempts.length > ATTEMPT_LOG_CAP ? [...attempts.slice(-ATTEMPT_LOG_CAP)] : [...attempts],
    );
    return;
  }
  // Mutate in place + trim from the front to keep amortized O(1) per
  // append without copying the whole history on each call.
  for (const a of attempts) {
    existing.push(a);
  }
  if (existing.length > ATTEMPT_LOG_CAP) {
    existing.splice(0, existing.length - ATTEMPT_LOG_CAP);
  }
}

function fireFailoverCallbacks(
  attempts: readonly VariantAttempt[],
  onFailover: ((attempt: VariantAttempt, nextVariantId: string) => void) | undefined,
): void {
  if (onFailover === undefined || attempts.length <= 1) return;
  for (let i = 0; i < attempts.length - 1; i++) {
    const attempt = attempts[i];
    const nextAttempt = attempts[i + 1];
    if (attempt !== undefined && !attempt.success && nextAttempt !== undefined) {
      onFailover(attempt, nextAttempt.variantId);
    }
  }
}

/** Creates a degenerate middleware with variant selection and failover. */
export function createDegenerateMiddleware(config: DegenerateMiddlewareConfig): DegenerateHandle {
  // Fail closed on invalid/empty configuration. Without this, a
  // manifest mistake silently produces an inert middleware that falls
  // through to next() with no startup signal — the entire redundancy
  // layer disappears with the runtime still reporting healthy.
  const validated = validateDegenerateConfig(config);
  if (!validated.ok) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `createDegenerateMiddleware: ${validated.error.message}`,
    );
  }

  // Reject configurations that advertise a strategy this middleware
  // cannot actually run end-to-end. `context-match` requires a
  // user-provided matcher, but the middleware does not yet expose a
  // hook for one — silently degrading to the default matcher (fitness
  // tie-break) would route real traffic to the wrong variant while
  // operators believe context routing is active.
  for (const [capability, capConfig] of config.capabilityConfigs) {
    if (capConfig.selectionStrategy === "context-match") {
      throw KoiRuntimeError.from(
        "VALIDATION",
        `createDegenerateMiddleware: capability "${capability}" requests selectionStrategy="context-match" but this middleware does not yet expose a contextMatcher hook. Use a different strategy or wait for context-match support.`,
      );
    }
  }

  const clock = config.clock ?? Date.now;
  const random = config.random ?? Math.random;
  const cbConfig = config.circuitBreakerConfig ?? DEFAULT_CIRCUIT_BREAKER_CONFIG;

  // Per-session state keyed by session ID
  const sessions = new Map<string, DegenerateSessionState>();

  /** Resolve session state by explicit ID or fall back to the sole active session. */
  function resolveState(sessionId?: string): DegenerateSessionState | undefined {
    if (sessionId !== undefined) {
      return sessions.get(sessionId);
    }
    // Fallback: if exactly one session is active, use it
    if (sessions.size === 1) {
      return sessions.values().next().value;
    }
    return undefined;
  }

  async function onSessionStart(ctx: SessionContext): Promise<void> {
    const result = await buildVariantPools({
      forgeStore: config.forgeStore,
      capabilityConfigs: config.capabilityConfigs,
      createToolExecutor: config.createToolExecutor,
      clock,
    });
    const aliasToVariantId = new Map<string, string>();
    for (const [variantId, alias] of result.variantAliases) {
      aliasToVariantId.set(alias, variantId);
    }
    const state: DegenerateSessionState = {
      pools: new Map(result.pools),
      toolToCapability: new Map(result.toolToCapability),
      variantAliases: new Map(result.variantAliases),
      aliasToVariantId,
      breakers: new Map(),
      roundRobinStates: new Map(),
      thompsonStates: new Map(),
      attemptLog: new Map(),
    };
    initBreakers(state, cbConfig, clock);
    sessions.set(ctx.sessionId as string, state);
  }

  async function onSessionEnd(ctx: SessionContext): Promise<void> {
    const sid = ctx.sessionId as string;
    const state = sessions.get(sid);
    if (state === undefined) return;
    // Dispose circuit breakers
    for (const [, breaker] of state.breakers) {
      breaker.reset();
    }
    sessions.delete(sid);
  }

  async function wrapToolCall(
    ctx: TurnContext,
    request: ToolRequest,
    next: ToolHandler,
  ): Promise<ToolResponse> {
    const state = sessions.get(ctx.session.sessionId as string);
    if (state === undefined) return next(request);

    // Look up which capability this tool belongs to
    const capability = state.toolToCapability.get(request.toolId);
    if (capability === undefined) return next(request);

    const pool = state.pools.get(capability);
    if (pool === undefined || pool.variants.length === 0) return next(request);

    // Get or create round-robin state for this capability
    let rrState = state.roundRobinStates.get(capability);
    if (rrState === undefined) {
      rrState = createRoundRobinState();
      state.roundRobinStates.set(capability, rrState);
    }

    // Persist Thompson posteriors per capability so the strategy actually
    // learns across calls; without this, every selection samples fresh
    // Beta(1,1) priors and degrades to random routing.
    let thompson = state.thompsonStates.get(capability);
    if (thompson === undefined) {
      thompson = new Map<string, ThompsonState>();
      state.thompsonStates.set(capability, thompson);
    }

    // Pin the addressed variant as the primary attempt: when the model
    // sends a request to a concrete alias (e.g. `search-scrape`), that
    // exact variant must execute first. The configured strategy
    // (fitness/thompson/random) still drives ordering for the
    // *failover* candidates so operators tuning the selector see its
    // effect on the hot path. Implementation: when failover is needed,
    // we run executeWithFailover on a sub-pool that excludes the
    // pinned variant — that sub-pool uses the configured strategy to
    // pick the next attempt. The pinned primary attempt is handled
    // outside executeWithFailover to keep its identity guaranteed.
    const pinnedVariantId = state.aliasToVariantId.get(request.toolId);
    const pinnedVariant =
      pinnedVariantId !== undefined
        ? pool.variants.find((v) => v.id === pinnedVariantId)
        : undefined;

    const dispatchExecute = async (variant: {
      readonly id: string;
      readonly value: ToolHandler;
    }): Promise<ToolResponse> => {
      // The caller-addressed public alias stays on `request.toolId`
      // so outer middleware (permissions, audit, provenance) keys on
      // a single identity per public tool call — the model addressed
      // the capability once, and all variants in the pool share that
      // authorization scope by contract. Variant identity is exposed
      // via metadata so executors and observability sinks that care
      // about which specific variant ran can read it directly.
      //
      // This middleware is pinned at the innermost tool-MW priority
      // (1000) so every cross-cutting middleware (audit, permissions,
      // security bridge, router, runtime guards) wraps the entire
      // degenerate dispatch — including failover attempts — from the
      // outside. Routing through next() is not an option: it would
      // re-resolve to the SAME terminal handler each attempt,
      // defeating failover entirely.
      const variantAlias = state.variantAliases.get(variant.id) ?? request.toolId;
      const dispatchRequest: ToolRequest = {
        ...request,
        metadata: {
          ...(request.metadata ?? {}),
          publicAlias: request.toolId,
          selectedVariantId: variant.id,
          selectedVariantAlias: variantAlias,
        },
      };
      return variant.value(dispatchRequest);
    };

    let outcome: Awaited<ReturnType<typeof executeWithFailover<ToolHandler, ToolResponse>>>;
    if (pinnedVariant !== undefined) {
      // Try the pinned variant manually as the primary attempt so its
      // identity is guaranteed regardless of strategy. On failure (and
      // when failoverEnabled), delegate the remaining variants to
      // executeWithFailover with the *configured* strategy so operators
      // tuning fitness/thompson/random still see their effect on the
      // failover hot path.
      const primaryStart = clock();
      const primaryBreaker = state.breakers.get(pinnedVariant.id);
      let primary:
        | { readonly ok: true; readonly result: ToolResponse }
        | { readonly ok: false; readonly error: unknown };
      try {
        const result = await dispatchExecute(pinnedVariant);
        primaryBreaker?.recordSuccess();
        primary = { ok: true, result };
      } catch (e: unknown) {
        primaryBreaker?.recordFailure();
        primary = { ok: false, error: e };
      }
      const primaryAttempt: VariantAttempt = {
        variantId: pinnedVariant.id,
        success: primary.ok,
        durationMs: clock() - primaryStart,
        ...(primary.ok
          ? {}
          : {
              error: primary.error instanceof Error ? primary.error.message : String(primary.error),
            }),
      };
      if (primary.ok) {
        outcome = {
          ok: true,
          value: {
            result: primary.result,
            attempts: [primaryAttempt],
            selectedVariantId: pinnedVariant.id,
          },
        };
      } else if (!pool.config.failoverEnabled || pool.variants.length === 1) {
        outcome = {
          ok: false,
          attempts: [primaryAttempt],
          lastError: primary.error,
        };
      } else {
        const restPool: VariantPool<ToolHandler> = {
          ...pool,
          variants: pool.variants.filter((v) => v.id !== pinnedVariant.id),
        };
        const rest = await executeWithFailover<ToolHandler, ToolResponse>({
          pool: restPool,
          breakers: state.breakers,
          selectOptions: {
            strategy: pool.config.selectionStrategy,
            ctx: { input: request.input, clock, random },
            roundRobinState: rrState,
            thompsonStates: thompson,
          },
          execute: dispatchExecute,
          clock,
        });
        outcome = rest.ok
          ? {
              ok: true,
              value: {
                result: rest.value.result,
                attempts: [primaryAttempt, ...rest.value.attempts],
                selectedVariantId: rest.value.selectedVariantId,
              },
            }
          : {
              ok: false,
              attempts: [primaryAttempt, ...rest.attempts],
              lastError: rest.lastError,
            };
      }
    } else {
      outcome = await executeWithFailover<ToolHandler, ToolResponse>({
        pool,
        breakers: state.breakers,
        selectOptions: {
          strategy: pool.config.selectionStrategy,
          ctx: { input: request.input, clock, random },
          roundRobinState: rrState,
          thompsonStates: thompson,
        },
        execute: dispatchExecute,
        clock,
      });
    }

    // Log attempts
    const attempts = outcome.ok ? outcome.value.attempts : outcome.attempts;
    logAttempts(state, capability, attempts);

    // Update Thompson posteriors from per-attempt outcomes so the strategy
    // adapts across calls. Touched even for non-thompson strategies — the
    // bookkeeping is cheap and consistent state lets operators switch
    // strategies at runtime without losing history.
    for (const attempt of attempts) {
      const prior = thompson.get(attempt.variantId) ?? createThompsonState();
      thompson.set(attempt.variantId, updateThompson(prior, attempt.success));
    }

    if (!outcome.ok) {
      config.onAllVariantsFailed?.(capability, outcome.attempts);
      throw outcome.lastError;
    }

    fireFailoverCallbacks(outcome.value.attempts, config.onFailover);

    // Attach attempt metadata to response
    return {
      ...outcome.value.result,
      metadata: {
        ...outcome.value.result.metadata,
        degenerateAttempts: outcome.value.attempts,
        selectedVariantId: outcome.value.selectedVariantId,
      },
    };
  }

  function describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
    const state = sessions.get(ctx.session.sessionId as string);
    if (state === undefined || state.pools.size === 0) return undefined;
    const totalVariants = [...state.pools.values()].reduce((sum, p) => sum + p.variants.length, 0);
    return {
      label: "degeneracy",
      description: `${String(state.pools.size)} capabilities with ${String(totalVariants)} degenerate variants`,
    };
  }

  const middleware: KoiMiddleware = {
    name: "degenerate",
    // Innermost tool-call middleware — runs adjacent to the terminal so
    // every cross-cutting middleware (audit, permissions, security
    // bridge, router, runtime guards) wraps the entire degenerate
    // dispatch including its failover attempts. The failover loop calls
    // `variant.value(request)` directly because degeneracy is an
    // implementation detail of *one* public tool call: outer layers see
    // a single invocation of the public alias and the chosen variant
    // surfaces in `metadata.selectedVariantId` / `degenerateAttempts`.
    // Higher than runtime-factory (999) and any other resolve-phase
    // tool wrapper to guarantee no later layer is skipped.
    priority: 1_000,
    onSessionStart,
    onSessionEnd,
    wrapToolCall,
    describeCapabilities,
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
