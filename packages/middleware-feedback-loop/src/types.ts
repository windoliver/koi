/**
 * Core types for the feedback-loop middleware.
 */

import type { ModelRequest, ModelResponse, TurnContext } from "@koi/core/middleware";

/** A single validation error produced by a Validator. */
export interface ValidationError {
  readonly validator: string;
  readonly message: string;
  readonly path?: string;
  /** When false, short-circuits retries immediately. Defaults to true if omitted. */
  readonly retryable?: boolean;
}

/** Discriminated result returned by validators. */
export type ValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly errors: readonly ValidationError[] };

/** Generic, framework-agnostic validator interface. */
export interface Validator {
  readonly name: string;
  readonly validate: (
    output: unknown,
    ctx: TurnContext,
  ) => ValidationResult | Promise<ValidationResult>;
}

/** Strategy for injecting error feedback into the retry request. */
export interface RepairStrategy {
  readonly buildRetryRequest: (
    original: ModelRequest,
    response: ModelResponse,
    errors: readonly ValidationError[],
    attempt: number,
  ) => ModelRequest | Promise<ModelRequest>;
}

// ---------------------------------------------------------------------------
// Tool health tracking types — re-exported from L0 (@koi/core)
// ---------------------------------------------------------------------------

import type {
  ToolFailureRecord,
  ToolHealthMetrics,
  ToolHealthSnapshot,
  ToolHealthState,
} from "@koi/core";

export type { ToolFailureRecord, ToolHealthMetrics, ToolHealthSnapshot, ToolHealthState };

/** Enriched error feedback returned to the agent when a tool is quarantined or degraded. */
export interface ForgeToolErrorFeedback {
  readonly error: string;
  readonly errorRate: number;
  readonly recentFailures: readonly ToolFailureRecord[];
  readonly suggestion: string;
}

// ---------------------------------------------------------------------------
// Trust demotion event (fired when a tool's trust tier is lowered)
// ---------------------------------------------------------------------------

/** Reason for a trust tier demotion. */
export type TrustDemotionReason =
  | "error_rate"
  | "dependency_failure"
  | "manual"
  | "re_verification_failed"
  | "source_drift";

/** Event emitted when a tool's trust tier is demoted. */
export interface TrustDemotionEvent {
  readonly brickId: string;
  readonly from: string;
  readonly to: string;
  readonly reason: TrustDemotionReason;
  readonly evidence: {
    readonly errorRate: number;
    readonly sampleSize: number;
    readonly periodMs: number;
  };
}

// ---------------------------------------------------------------------------
// Demotion criteria — moved from @koi/core (Issue #703)
// ---------------------------------------------------------------------------

/** Configuration for automated trust tier demotion on sustained error rate. */
export interface DemotionCriteria {
  /** Error rate threshold to trigger demotion (0-1). E.g., 0.3 = 30%. */
  readonly errorRateThreshold: number;
  /** Number of recent invocations to evaluate for demotion. */
  readonly windowSize: number;
  /** Minimum number of filled slots before demotion can trigger. */
  readonly minSampleSize: number;
  /** Don't demote within this many ms of a promotion. */
  readonly gracePeriodMs: number;
  /** Minimum time between consecutive demotions in ms. */
  readonly demotionCooldownMs: number;
}

/** Sensible defaults for demotion criteria. */
export const DEFAULT_DEMOTION_CRITERIA: DemotionCriteria = Object.freeze({
  errorRateThreshold: 0.3,
  windowSize: 20,
  minSampleSize: 10,
  gracePeriodMs: 3_600_000,
  demotionCooldownMs: 1_800_000,
});

// ---------------------------------------------------------------------------
// Discovery miss tracking
// ---------------------------------------------------------------------------

/** Record of a resolver discovery returning zero results. */
export interface DiscoveryMissRecord {
  readonly timestamp: number;
  readonly resolverSource: string;
}

/** Category-aware retry budget configuration. */
export interface RetryConfig {
  readonly validation?: {
    readonly maxAttempts?: number;
    readonly delayMs?: number;
  };
  readonly transport?: {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
  };
}
