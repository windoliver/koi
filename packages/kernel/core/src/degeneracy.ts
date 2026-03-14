/**
 * Degeneracy types — multiple structurally different implementations of the
 * same capability, selected by fitness or context at runtime.
 *
 * L0 types only — no logic, no dependencies.
 */

/**
 * Strategy used to select among degenerate variants of a capability.
 *
 * - `"fitness"` — highest fitness score wins (weighted random by score)
 * - `"round-robin"` — rotate for load distribution + data collection
 * - `"context-match"` — select based on input characteristics
 * - `"random"` — uniform random (for A/B testing)
 * - `"thompson"` — Thompson sampling via Beta posteriors (exploration/exploitation balance)
 */
export type SelectionStrategy = "fitness" | "round-robin" | "context-match" | "random" | "thompson";

/**
 * Per-capability degeneracy configuration declared in the agent manifest.
 *
 * Controls how many variants are maintained and how the primary is selected.
 */
export interface DegeneracyConfig {
  readonly selectionStrategy: SelectionStrategy;
  /** Minimum active implementations. Default: 1. */
  readonly minVariants: number;
  /** Maximum active implementations (cap to prevent bloat). Default: 3. */
  readonly maxVariants: number;
  /** Auto-fallback to next variant on failure. Default: true. */
  readonly failoverEnabled: boolean;
}

/** Sensible defaults for degeneracy config — fitness-based with failover. */
export const DEFAULT_DEGENERACY_CONFIG: DegeneracyConfig = Object.freeze({
  selectionStrategy: "fitness",
  minVariants: 1,
  maxVariants: 3,
  failoverEnabled: true,
} as const);

/**
 * Record of a single variant execution attempt during failover.
 *
 * Collected by the middleware and attached to ToolResponse.metadata for
 * observability and fitness signal updates.
 */
export interface VariantAttempt {
  readonly variantId: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly error?: string;
}
