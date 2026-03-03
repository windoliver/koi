/**
 * Mock validator factories for testing validation middleware.
 *
 * Types are structurally compatible with @koi/middleware-feedback-loop's
 * Validator interface without importing it (avoids circular dependency).
 */

import type { TurnContext } from "@koi/core/middleware";

/** Structurally matches ValidationError from middleware-feedback-loop. */
export interface MockValidationError {
  readonly validator: string;
  readonly message: string;
  readonly path?: string;
  readonly retryable?: boolean;
}

/** Structurally matches ValidationResult from middleware-feedback-loop. */
export type MockValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly errors: readonly MockValidationError[] };

/** Structurally matches Validator from middleware-feedback-loop. */
export interface MockValidator {
  readonly name: string;
  readonly validate: (
    output: unknown,
    ctx: TurnContext,
  ) => MockValidationResult | Promise<MockValidationResult>;
}

/** Creates a validator that always passes. */
export function createMockValidator(name?: string): MockValidator {
  return {
    name: name ?? "mock-validator",
    validate: () => ({ valid: true as const }),
  };
}

/** Creates a validator that always fails with the given errors. */
export function createFailingValidator(
  errors: readonly MockValidationError[],
  name?: string,
): MockValidator {
  return {
    name: name ?? "failing-validator",
    validate: () => ({ valid: false as const, errors }),
  };
}

/** Creates a validator that resolves after a delay. */
export function createAsyncValidator(
  delayMs: number,
  result: MockValidationResult,
  name?: string,
): MockValidator {
  return {
    name: name ?? "async-validator",
    validate: async () => {
      await Bun.sleep(delayMs);
      return result;
    },
  };
}

/** Creates a validator that throws the given error. */
export function createThrowingValidator(error: Error, name?: string): MockValidator {
  return {
    name: name ?? "throwing-validator",
    validate: () => {
      throw error;
    },
  };
}

/** Creates a validator that passes or fails based on a predicate. */
export function createConditionalValidator(
  fn: (output: unknown) => boolean,
  name?: string,
): MockValidator {
  const validatorName = name ?? "conditional-validator";
  return {
    name: validatorName,
    validate: (output: unknown) => {
      if (fn(output)) return { valid: true as const };
      return {
        valid: false as const,
        errors: [{ validator: validatorName, message: "Condition not met" }],
      };
    },
  };
}
