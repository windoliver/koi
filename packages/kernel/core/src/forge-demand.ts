/**
 * Forge demand types — demand-triggered forging signal system.
 *
 * Defines the signal and budget types for pull-based forge triggering.
 * Middleware detects capability gaps and emits ForgeDemandSignal when
 * environmental pressure demands new tool creation.
 */

import type { BrickKind } from "./forge-types.js";

// ---------------------------------------------------------------------------
// Trigger kinds — discriminated union of demand sources
// ---------------------------------------------------------------------------

/** Discriminated union of demand trigger kinds. */
export type ForgeTrigger =
  | { readonly kind: "repeated_failure"; readonly toolName: string; readonly count: number }
  | { readonly kind: "no_matching_tool"; readonly query: string; readonly attempts: number }
  | { readonly kind: "capability_gap"; readonly requiredCapability: string }
  | {
      readonly kind: "performance_degradation";
      readonly toolName: string;
      readonly metric: string;
    };

// ---------------------------------------------------------------------------
// Demand signal — emitted by middleware when patterns detected
// ---------------------------------------------------------------------------

/** Signal emitted by the demand detector middleware when a forge need is detected. */
export interface ForgeDemandSignal {
  readonly id: string;
  readonly kind: "forge_demand";
  readonly trigger: ForgeTrigger;
  /** Confidence score (0-1) that forging is warranted. */
  readonly confidence: number;
  readonly suggestedBrickKind: BrickKind;
  readonly context: {
    readonly failureCount: number;
    readonly failedToolCalls: readonly string[];
    readonly taskDescription?: string | undefined;
  };
  readonly emittedAt: number;
}

// ---------------------------------------------------------------------------
// Budget — demand-aware forge budget configuration
// ---------------------------------------------------------------------------

/** Demand-aware budget configuration for forge triggering. */
export interface ForgeBudget {
  /** Hard cap on forges per session (safety limit). */
  readonly maxForgesPerSession: number;
  /** Total forge compute time budget in milliseconds. */
  readonly computeTimeBudgetMs: number;
  /** Minimum confidence to auto-suggest forge (0-1). */
  readonly demandThreshold: number;
  /** Minimum time between forge suggestions for the same trigger key (ms). */
  readonly cooldownMs: number;
}

/** Sensible defaults for forge budget. */
export const DEFAULT_FORGE_BUDGET: ForgeBudget = {
  maxForgesPerSession: 5,
  computeTimeBudgetMs: 120_000,
  demandThreshold: 0.7,
  cooldownMs: 30_000,
} as const;
