/**
 * Category-aware retry loop with validation and transport budgets.
 */

import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import type { RepairStrategy, RepairStrategyInput, RetryConfig, ValidationError } from "./types.js";

const DEFAULT_VALIDATION_MAX_ATTEMPTS = 3;
const DEFAULT_VALIDATION_DELAY_MS = 0;
const DEFAULT_TRANSPORT_MAX_ATTEMPTS = 3;
const DEFAULT_TRANSPORT_BASE_DELAY_MS = 1000;
const DEFAULT_TRANSPORT_MAX_DELAY_MS = 30_000;

/** Internal sentinel error: carries validation errors + the model response for repair. */
export class ValidationFailure extends Error {
  readonly errors: readonly ValidationError[];
  readonly response: ModelResponse;

  constructor(errors: readonly ValidationError[], response: ModelResponse) {
    super("Validation failed");
    this.name = "ValidationFailure";
    this.errors = errors;
    this.response = response;
  }
}

function hasNonRetryableError(errors: readonly ValidationError[]): boolean {
  return errors.some((e) => e.retryable === false);
}

/** Exponential backoff with jitter: min(maxDelay, baseDelay * 2^attempt) + random(0, baseDelay). */
export function computeTransportDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  const jitter = Math.random() * baseDelayMs;
  return exponential + jitter;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeErrors(errors: readonly ValidationError[]): readonly Record<string, unknown>[] {
  return errors.map((err) => ({
    validator: err.validator,
    message: err.message,
    ...(err.path !== undefined ? { path: err.path } : {}),
  }));
}

/** Resolve a RepairStrategyInput to a concrete RepairStrategy. */
export function resolveRepairStrategy(input: RepairStrategyInput): RepairStrategy {
  if (typeof input === "function" && !("buildRetryRequest" in input)) {
    return input();
  }
  return input as RepairStrategy;
}

/** Retry loop instance with category-aware budgets. */
export interface RetryLoop {
  readonly execute: (
    fn: (request: ModelRequest) => Promise<ModelResponse>,
    initialRequest: ModelRequest,
    repair: RepairStrategyInput,
    onRetry?: (attempt: number, errors: readonly ValidationError[]) => void,
  ) => Promise<ModelResponse>;
}

/** Creates a retry loop with the given config (uses sensible defaults). */
export function createRetryLoop(config: RetryConfig): RetryLoop {
  const validationMax = config.validation?.maxAttempts ?? DEFAULT_VALIDATION_MAX_ATTEMPTS;
  const validationDelay = config.validation?.delayMs ?? DEFAULT_VALIDATION_DELAY_MS;
  const transportMax = config.transport?.maxAttempts ?? DEFAULT_TRANSPORT_MAX_ATTEMPTS;
  const transportBase = config.transport?.baseDelayMs ?? DEFAULT_TRANSPORT_BASE_DELAY_MS;
  const transportCap = config.transport?.maxDelayMs ?? DEFAULT_TRANSPORT_MAX_DELAY_MS;

  return {
    async execute(
      fn: (request: ModelRequest) => Promise<ModelResponse>,
      initialRequest: ModelRequest,
      repair: RepairStrategyInput,
      onRetry?: (attempt: number, errors: readonly ValidationError[]) => void,
    ): Promise<ModelResponse> {
      // let: retry state — mutated across loop iterations
      let currentRequest = initialRequest;
      let validationAttempts = 0;
      let transportAttempts = 0;
      const allValidationErrors: ValidationError[] = [];
      // let: lazily resolved on first validation retry
      let resolvedRepair: RepairStrategy | undefined;

      for (;;) {
        try {
          return await fn(currentRequest);
        } catch (e: unknown) {
          if (e instanceof ValidationFailure) {
            validationAttempts++;
            allValidationErrors.push(...e.errors);

            // Early termination: non-retryable error
            if (hasNonRetryableError(e.errors)) {
              throw KoiRuntimeError.from(
                "VALIDATION",
                "Validation failed with non-retryable error",
                {
                  context: {
                    attempts: validationAttempts,
                    errors: serializeErrors(allValidationErrors),
                  },
                },
              );
            }

            // Budget exhausted
            if (validationAttempts >= validationMax) {
              throw KoiRuntimeError.from(
                "VALIDATION",
                `Validation failed after ${validationAttempts} attempt${validationAttempts === 1 ? "" : "s"}`,
                {
                  context: {
                    attempts: validationAttempts,
                    errors: serializeErrors(allValidationErrors),
                  },
                },
              );
            }

            // Lazily resolve on first retry (enables post-construction wiring)
            if (resolvedRepair === undefined) {
              resolvedRepair = resolveRepairStrategy(repair);
            }

            // Static pre-check: abort if repair strategy says stop (Issue #937: 13A)
            if (resolvedRepair.shouldRetry !== undefined) {
              const shouldContinue = await resolvedRepair.shouldRetry(e.errors, validationAttempts);
              if (!shouldContinue) {
                throw KoiRuntimeError.from(
                  "VALIDATION",
                  `Repair strategy aborted retry at attempt ${validationAttempts}`,
                  {
                    context: {
                      attempts: validationAttempts,
                      errors: serializeErrors(allValidationErrors),
                    },
                  },
                );
              }
            }

            onRetry?.(validationAttempts, e.errors);
            await delay(validationDelay);
            currentRequest = await resolvedRepair.buildRetryRequest(
              initialRequest,
              e.response,
              e.errors,
              validationAttempts,
            );
          } else {
            transportAttempts++;

            if (transportAttempts >= transportMax) {
              throw e;
            }

            const backoff = computeTransportDelay(
              transportAttempts - 1,
              transportBase,
              transportCap,
            );
            await delay(backoff);
          }
        }
      }
    },
  };
}
