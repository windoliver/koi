/**
 * Sequential validator execution with collect-all error aggregation.
 */

import type { TurnContext } from "@koi/core/middleware";
import type { ValidationError, ValidationResult, Validator } from "./types.js";

/** Runs all validators sequentially, collecting every error across all validators. */
export async function runValidators(
  output: unknown,
  validators: readonly Validator[],
  ctx: TurnContext,
): Promise<ValidationResult> {
  // let: accumulator mutated in loop — required for collect-all pattern
  const errors: ValidationError[] = [];

  for (const validator of validators) {
    try {
      const result = await validator.validate(output, ctx);
      if (!result.valid) {
        errors.push(...result.errors);
      }
    } catch (e: unknown) {
      errors.push({
        validator: validator.name,
        message: `Validator threw: ${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
      });
    }
  }

  if (errors.length === 0) {
    return { valid: true };
  }

  return { valid: false, errors };
}
