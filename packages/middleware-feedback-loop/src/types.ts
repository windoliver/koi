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
// Tool health tracking types (forge runtime health)
// ---------------------------------------------------------------------------

/** Aggregated health metrics for a single tool. */
export interface ToolHealthMetrics {
  /** Success rate (0-1). */
  readonly successRate: number;
  /** Error rate (0-1). */
  readonly errorRate: number;
  /** Total invocations in the tracking window. */
  readonly usageCount: number;
  /** Average latency in milliseconds. */
  readonly avgLatencyMs: number;
}

/** Health state of a forged tool. */
export type ToolHealthState = "healthy" | "degraded" | "quarantined";

/** Point-in-time snapshot of a tool's health. */
export interface ToolHealthSnapshot {
  readonly brickId: string;
  readonly toolId: string;
  readonly metrics: ToolHealthMetrics;
  readonly state: ToolHealthState;
  readonly recentFailures: readonly ToolFailureRecord[];
  readonly lastUpdatedAt: number;
}

/** Record of a single tool failure. */
export interface ToolFailureRecord {
  readonly timestamp: number;
  readonly error: string;
  readonly latencyMs: number;
}

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
  | "re_verification_failed";

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
