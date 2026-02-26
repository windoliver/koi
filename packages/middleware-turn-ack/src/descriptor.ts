/**
 * BrickDescriptor for @koi/middleware-turn-ack.
 *
 * Enables manifest auto-resolution: validates turn-ack config,
 * then creates the turn acknowledgement middleware.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createTurnAckMiddleware } from "./turn-ack.js";

function validateTurnAckDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Turn-ack options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  if (
    opts.debounceMs !== undefined &&
    (typeof opts.debounceMs !== "number" || opts.debounceMs < 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "turn-ack.debounceMs must be a non-negative number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for turn-ack middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-turn-ack",
  aliases: ["turn-ack"],
  optionsValidator: validateTurnAckDescriptorOptions,
  factory(options): KoiMiddleware {
    const debounceMs = typeof options.debounceMs === "number" ? options.debounceMs : undefined;
    const toolStatus = typeof options.toolStatus === "boolean" ? options.toolStatus : undefined;

    const config: Record<string, unknown> = {};
    if (debounceMs !== undefined) {
      (config as { debounceMs: number }).debounceMs = debounceMs;
    }
    if (toolStatus !== undefined) {
      (config as { toolStatus: boolean }).toolStatus = toolStatus;
    }

    return createTurnAckMiddleware(
      Object.keys(config).length > 0
        ? (config as Parameters<typeof createTurnAckMiddleware>[0])
        : undefined,
    );
  },
};
