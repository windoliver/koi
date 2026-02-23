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
  ) => ModelRequest;
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
