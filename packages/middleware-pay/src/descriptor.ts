/**
 * BrickDescriptor for @koi/middleware-pay.
 *
 * Enables manifest auto-resolution: validates pay config,
 * then creates the pay middleware with in-memory pay ledger
 * and default cost calculator.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createPayMiddleware } from "./pay.js";
import { createDefaultCostCalculator, createInMemoryPayLedger } from "./tracker.js";

function validatePayDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Pay options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  if (typeof opts.budget !== "number" || opts.budget <= 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "pay.budget is required and must be a positive number (USD)",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for pay middleware.
 * Uses in-memory pay ledger and default cost calculator.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-pay",
  aliases: ["pay"],
  optionsValidator: validatePayDescriptorOptions,
  factory(options): KoiMiddleware {
    const budget = options.budget as number;
    const ledger = createInMemoryPayLedger(budget);
    const calculator = createDefaultCostCalculator();

    return createPayMiddleware({ ledger, calculator, budget });
  },
};
