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
import type { CircuitBreakerConfig } from "@koi/errors";
import type { VariantPool } from "@koi/variant-selection";

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

/** Handle returned by the degenerate middleware factory. */
export interface DegenerateHandle {
  readonly middleware: KoiMiddleware;
  readonly getVariantPool: (capability: string) => VariantPool<ToolHandler> | undefined;
  readonly getAttemptLog: (capability: string) => readonly VariantAttempt[];
}
