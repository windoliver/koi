/**
 * Configuration for TurnAckMiddleware.
 */

import type { KoiError, Result } from "@koi/core";

export interface TurnAckConfig {
  /** Debounce threshold in ms. Ack is skipped if turn completes within this time. Default: 100. */
  readonly debounceMs?: number;
  /** Send "processing" status with tool name detail on each tool call. Default: true. */
  readonly toolStatus?: boolean;
  /** Called when sendStatus fails (e.g., channel disconnected). Default: console.warn. */
  readonly onError?: (error: unknown) => void;
}

export function validateConfig(config: TurnAckConfig): Result<TurnAckConfig, KoiError> {
  if (
    config.debounceMs !== undefined &&
    (config.debounceMs < 0 || !Number.isFinite(config.debounceMs))
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "debounceMs must be a non-negative finite number",
        retryable: false,
        context: { debounceMs: config.debounceMs },
      },
    };
  }
  return { ok: true, value: config };
}
