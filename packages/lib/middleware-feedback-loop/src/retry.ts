import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import { isKoiError, isRetryable, KoiRuntimeError } from "@koi/errors";
import { runGates } from "./gate.js";
import type { Gate, RepairStrategy, ValidationError, Validator } from "./types.js";
import { runValidators } from "./validators.js";

export interface RetryOptions {
  readonly validators: readonly Validator[];
  readonly gates: readonly Gate[];
  readonly repairStrategy: RepairStrategy;
  readonly validationMaxAttempts: number;
  /** Maximum total transport attempts including the first call (not a retry count). */
  /** Maximum transport retries allowed (0 = no retries, first transport error is terminal). */
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
      // Only skip retry when the error explicitly carries non-retryable KoiError metadata.
      // Plain Error instances (network stack, provider client) have no retryability info and
      // should be retried — they represent transient transport failures, not policy blocks.
      // Non-retryable conditions (auth failures, request-shape errors, policy blocks) always
      // surface as KoiErrors with retryable: false, either thrown directly or in Error.cause.
      const koiErr = isKoiError(err)
        ? err
        : err instanceof Error && isKoiError(err.cause)
          ? err.cause
          : null;
      if (koiErr !== null && !isRetryable(koiErr)) throw err;
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
