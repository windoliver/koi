/**
 * BrickDescriptor for @koi/middleware-pay.
 *
 * Enables manifest auto-resolution: validates pay config,
 * then creates the pay middleware with in-memory budget tracker
 * and default cost calculator.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createPayMiddleware } from "./pay.js";
import { createDefaultCostCalculator, createInMemoryBudgetTracker } from "./tracker.js";

function validatePayDescriptorOptions(input: unknown): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "Pay");
  if (!base.ok) return base;
  const opts = base.value;

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

  return { ok: true, value: opts };
}

/**
 * Descriptor for pay middleware.
 * Uses in-memory budget tracker and default cost calculator.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-pay",
  aliases: ["pay"],
  optionsValidator: validatePayDescriptorOptions,
  factory(options): KoiMiddleware {
    const budget = options.budget as number;
    const tracker = createInMemoryBudgetTracker();
    const calculator = createDefaultCostCalculator();

    return createPayMiddleware({ tracker, calculator, budget });
  },
};
