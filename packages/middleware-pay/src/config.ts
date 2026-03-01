/**
 * Pay middleware configuration and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { PayLedger } from "@koi/core/pay-ledger";
import type { CostCalculator } from "./tracker.js";

export interface UsageInfo {
  readonly model: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalSpent: number;
  readonly remaining: number;
}

export interface PayMiddlewareConfig {
  readonly ledger: PayLedger;
  readonly calculator: CostCalculator;
  readonly budget: number;
  readonly alertThresholds?: readonly number[];
  readonly onAlert?: (pctUsed: number, remaining: number) => void;
  readonly onUsage?: (info: UsageInfo) => void;
  readonly hardKill?: boolean;
}

export function validatePayConfig(config: unknown): Result<PayMiddlewareConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config must be a non-null object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const c = config as Record<string, unknown>;

  if (!c.ledger || typeof c.ledger !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a 'ledger' with meter/getBalance methods",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (!c.calculator || typeof c.calculator !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a 'calculator' with a 'calculate' method",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (typeof c.budget !== "number" || c.budget < 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a non-negative 'budget' number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.alertThresholds !== undefined) {
    if (!Array.isArray(c.alertThresholds)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "alertThresholds must be an array of numbers between 0 and 1",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    for (const t of c.alertThresholds as readonly unknown[]) {
      if (typeof t !== "number" || t < 0 || t > 1) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Each alert threshold must be a number between 0 and 1",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
    }
  }

  return { ok: true, value: config as PayMiddlewareConfig };
}
