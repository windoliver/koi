import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import { isKoiError, isRetryable, KoiRuntimeError, toKoiError } from "@koi/errors";
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
      // Only retry explicitly transient/retryable transport failures. Non-retryable errors
      // (auth failures, deterministic request-shape errors, policy blocks) are rethrown
      // immediately so they are not replayed and do not risk duplicate side effects.
      // Adapters may throw plain Error with KoiError metadata in Error.cause — check cause
      // before falling back to toKoiError() which otherwise hard-codes retryable: false.
      const koiErr = err instanceof Error && isKoiError(err.cause) ? err.cause : toKoiError(err);
      if (!isRetryable(koiErr)) throw err;
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
