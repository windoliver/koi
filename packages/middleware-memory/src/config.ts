/**
 * Memory middleware configuration and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { MemoryStore } from "./store.js";

export interface MemoryMiddlewareConfig {
  readonly store: MemoryStore;
  readonly maxRecallTokens?: number;
  readonly recallStrategy?: "recent" | "relevant" | "hybrid";
  readonly storeResponses?: boolean;
  /** Called when storing a response fails. If not provided, store errors are silently ignored. */
  readonly onStoreError?: (error: unknown) => void;
}

export function validateConfig(config: unknown): Result<MemoryMiddlewareConfig, KoiError> {
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

  if (!c.store || typeof c.store !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a 'store' with recall and store methods",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.maxRecallTokens !== undefined) {
    if (typeof c.maxRecallTokens !== "number" || c.maxRecallTokens <= 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "maxRecallTokens must be a positive number",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  if (c.recallStrategy !== undefined) {
    const validStrategies = ["recent", "relevant", "hybrid"];
    if (!validStrategies.includes(c.recallStrategy as string)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `recallStrategy must be one of: ${validStrategies.join(", ")}`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  return { ok: true, value: config as MemoryMiddlewareConfig };
}
