import type { TrustTier } from "@koi/core";
import type { BrickId } from "@koi/core/brick-snapshot";
import type { BrickFitnessMetrics, LatencySampler } from "@koi/core/brick-store";
import type { ModelRequest, ModelResponse, ToolResponse } from "@koi/core/middleware";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  readonly validator: string;
  readonly message: string;
  readonly path?: string | undefined;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors?: readonly ValidationError[];
}

export interface Validator {
  readonly name: string;
  readonly validate: (response: ModelResponse) => ValidationResult | Promise<ValidationResult>;
}

export interface Gate {
  readonly name: string;
  readonly validate: (
    response: ModelResponse | ToolResponse,
  ) => ValidationResult | Promise<ValidationResult>;
  /**
   * When true, gate failures are recorded as tool health failures and can
   * trigger quarantine/demotion. Default: false — gates are policy checks,
   * not reliability signals.
   */
  readonly countAsHealthFailure?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Retry / Repair
// ---------------------------------------------------------------------------

export interface RetryContext {
  readonly attempt: number;
  /** The model's failed response — available for repair strategy context. */
  readonly response: ModelResponse;
  /** Opaque ID of the feedback message from the previous attempt. Undefined on first retry. */
  readonly feedbackMessageId: string | undefined;
}

export interface RepairStrategy {
  /**
   * Builds the next retry request from the LAST EFFECTIVE request (preserves
   * per-attempt middleware state). Returns the rebuilt request and an opaque
   * feedbackMessageId that identifies the feedback slot for subsequent retries.
   */
  readonly buildRetryRequest: (
    currentRequest: ModelRequest,
    errors: readonly ValidationError[],
    ctx: RetryContext,
  ) => { readonly request: ModelRequest; readonly feedbackMessageId: string };
}

// ---------------------------------------------------------------------------
// Tool Health
// ---------------------------------------------------------------------------

export type HealthState = "healthy" | "degraded" | "quarantined";
export type HealthActionKind = "none" | "demote" | "quarantine";

export interface HealthAction {
  readonly state: HealthState;
  readonly action: HealthActionKind;
}

export interface RingEntry {
  readonly success: boolean;
  readonly latencyMs: number;
}

export interface ToolHealthMetrics {
  readonly errorCount: number;
  readonly totalCount: number;
  readonly entries: readonly RingEntry[];
}

export interface DemotionCriteria {
  readonly errorRateThreshold: number;
  readonly windowSize: number;
  readonly minSampleSize: number;
  readonly gracePeriodMs: number;
  readonly demotionCooldownMs: number;
}

export interface TrustDemotionEvent {
  readonly brickId: BrickId;
  readonly from: TrustTier;
  readonly to: TrustTier;
  readonly reason: "error_rate";
  readonly evidence: {
    readonly errorRate: number;
    readonly sampleSize: number;
  };
}

export interface ToolHealthSnapshot {
  readonly toolId: string;
  readonly brickId: BrickId;
  readonly healthState: HealthState;
  readonly trustTier: TrustTier | undefined;
  readonly errorRate: number;
  readonly totalCount: number;
  readonly flushSuspended: boolean;
}

/** Returned when a quarantined tool is requested — tool never executes. */
export interface ForgeToolErrorFeedback {
  readonly kind: "forge_tool_quarantined";
  readonly brickId: BrickId;
  readonly toolId: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Fitness flush
// ---------------------------------------------------------------------------

export interface ToolFlushState {
  readonly dirty: boolean;
  readonly flushing: boolean;
  readonly invocationsSinceFlush: number;
  readonly errorRateSinceFlush: number;
  readonly lastFlushedErrorRate: number;
}

export interface FlushDeltas {
  readonly successCount: number;
  readonly errorCount: number;
  readonly latencySampler: LatencySampler;
  readonly lastUsedAt: number;
}

// ---------------------------------------------------------------------------
// Health transition error
// ---------------------------------------------------------------------------

export interface HealthTransitionErrorEvent {
  readonly transition: "quarantine" | "demotion";
  readonly phase: "forgeStore" | "snapshot";
  readonly brickId: BrickId;
  readonly error: unknown;
}

// Re-export BrickFitnessMetrics so callers can reference the fitness shape
// without importing directly from @koi/core/brick-store.
export type { BrickFitnessMetrics };
