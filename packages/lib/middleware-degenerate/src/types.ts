/**
 * Types for the degenerate middleware.
 */

import type {
  BrickArtifact,
  DegeneracyConfig,
  ForgeStore,
  KoiMiddleware,
  ToolHandler,
  VariantAttempt,
} from "@koi/core";
import type { CircuitBreaker, CircuitBreakerConfig } from "@koi/errors";
import type { RoundRobinState, ThompsonState, VariantPool } from "@koi/variant-selection";

/** Configuration for the degenerate middleware factory. */
export interface DegenerateMiddlewareConfig {
  readonly forgeStore: ForgeStore;
  /** Factory to create an executable ToolHandler from a brick artifact. */
  readonly createToolExecutor: (brick: BrickArtifact) => ToolHandler | Promise<ToolHandler>;
  /** Capability name → degeneracy config, from the agent manifest. */
  readonly capabilityConfigs: ReadonlyMap<string, DegeneracyConfig>;
  readonly circuitBreakerConfig?: CircuitBreakerConfig | undefined;
  readonly clock?: (() => number) | undefined;
  readonly random?: (() => number) | undefined;
  /** Called when primary fails and an alternative is attempted. */
  readonly onFailover?: ((attempt: VariantAttempt, nextVariantId: string) => void) | undefined;
  /** Called when all variants for a capability have failed. */
  readonly onAllVariantsFailed?:
    | ((capability: string, attempts: readonly VariantAttempt[]) => void)
    | undefined;
}

/** Per-session mutable state for the degenerate middleware. */
export interface DegenerateSessionState {
  readonly pools: Map<string, VariantPool<ToolHandler>>;
  readonly toolToCapability: Map<string, string>;
  /** Variant id → brick.name (the variant's own public alias). Used to
   *  rewrite ToolRequest.toolId when an alternate variant is selected,
   *  so downstream policy/audit code keys on the actually-executing
   *  identity instead of the originally-addressed alias. */
  readonly variantAliases: Map<string, string>;
  /** brick.name → variant id (reverse of variantAliases). Used to pin
   *  the addressed variant as the primary attempt so explicit aliases
   *  don't get silently substituted by strategy selection. */
  readonly aliasToVariantId: Map<string, string>;
  readonly breakers: Map<string, CircuitBreaker>;
  readonly roundRobinStates: Map<string, RoundRobinState>;
  /** Thompson posteriors keyed by capability → variantId → ThompsonState. */
  readonly thompsonStates: Map<string, Map<string, ThompsonState>>;
  readonly attemptLog: Map<string, VariantAttempt[]>;
}

/** Handle returned by the degenerate middleware factory. */
export interface DegenerateHandle {
  readonly middleware: KoiMiddleware;
  readonly getVariantPool: (
    capability: string,
    sessionId?: string,
  ) => VariantPool<ToolHandler> | undefined;
  readonly getAttemptLog: (capability: string, sessionId?: string) => readonly VariantAttempt[];
}
