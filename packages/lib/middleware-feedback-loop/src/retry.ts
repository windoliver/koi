import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import { isKoiError, isRetryable, KoiRuntimeError, toKoiError } from "@koi/errors";
import { runGates } from "./gate.js";
import type { Gate, RepairStrategy, ValidationError, Validator } from "./types.js";
import { runValidators } from "./validators.js";

/**
 * Extracts retryability from an error, handling three shapes:
 * 1. Full KoiError thrown directly → use isRetryable()
 * 2. Error with partial KoiError-shaped cause ({ code, retryable }) but missing message →
 *    adapters often throw Error('msg', { cause: { code, retryable } }) without a full KoiError
 * 3. Anything else → toKoiError() fallback (returns retryable: false)
 */
export function resolveRetryable(err: unknown): boolean {
  if (isKoiError(err)) return isRetryable(err);
  if (err instanceof Error) {
    const cause = err.cause;
    if (isKoiError(cause)) return isRetryable(cause);
    // Partial cause: has code + retryable but no message (not a full KoiError)
    if (
      cause !== null &&
      cause !== undefined &&
      typeof cause === "object" &&
      "retryable" in cause &&
      typeof (cause as { retryable: unknown }).retryable === "boolean"
    ) {
      return (cause as { retryable: boolean }).retryable;
    }
  }
  return isRetryable(toKoiError(err));
}

export interface RetryOptions {
  readonly validators: readonly Validator[];
  readonly gates: readonly Gate[];
  readonly repairStrategy: RepairStrategy;
  readonly validationMaxAttempts: number;
  /** Maximum transport retries allowed (0 = no retries, 1 = one retry, etc.). */
  readonly transportMaxAttempts: number;
  readonly onRetry?: ((attempt: number, errors: readonly ValidationError[]) => void) | undefined;
  readonly onGateFail?: ((gate: Gate, errors: readonly ValidationError[]) => void) | undefined;
}

export async function runWithRetry(
  originalRequest: ModelRequest,
  next: (request: ModelRequest) => Promise<ModelResponse>,
  options: RetryOptions,
): Promise<ModelResponse> {
  // let-bindings with justification: mutable loop state tracking across retries
  let currentRequest = originalRequest;
  let feedbackMessageId: string | undefined;
  let validationAttempts = 0;
  // transportErrors counts only network/API failures — independent of validation retries
  let transportErrors = 0;

  while (true) {
    let response: ModelResponse;
    try {
      response = await next(currentRequest);
    } catch (err) {
      if (!resolveRetryable(err)) throw err;
      transportErrors++;
      if (transportErrors > options.transportMaxAttempts) throw err;
      // Emit onRetry so transport-error retries are observable alongside validation retries
      options.onRetry?.(validationAttempts + transportErrors, []);
      continue;
    }

    const errors = await runValidators(options.validators, response);

    if (errors.length === 0) {
      await runGates(options.gates, response, options.onGateFail);
      return response;
    }

    validationAttempts++;

    if (validationAttempts >= options.validationMaxAttempts) {
      throw KoiRuntimeError.from(
        "VALIDATION",
        `Validation budget exhausted after ${options.validationMaxAttempts} attempt(s): ${errors.map((e) => e.message).join("; ")}`,
      );
    }

    options.onRetry?.(validationAttempts, errors);

    const built = options.repairStrategy.buildRetryRequest(currentRequest, errors, {
      attempt: validationAttempts,
      response,
      feedbackMessageId,
    });
    currentRequest = built.request;
    feedbackMessageId = built.feedbackMessageId;
  }
}
