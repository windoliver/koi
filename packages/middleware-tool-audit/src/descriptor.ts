/**
 * BrickDescriptor for @koi/middleware-tool-audit.
 *
 * Enables manifest auto-resolution: validates audit options,
 * then creates tool audit middleware.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createToolAuditMiddleware } from "./tool-audit.js";

function validateToolAuditDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Tool audit options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  if (
    opts.unusedThresholdSessions !== undefined &&
    (typeof opts.unusedThresholdSessions !== "number" || opts.unusedThresholdSessions <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-audit.unusedThresholdSessions must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    opts.minCallsForFailure !== undefined &&
    (typeof opts.minCallsForFailure !== "number" || opts.minCallsForFailure <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-audit.minCallsForFailure must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    opts.minSessionsForAdoption !== undefined &&
    (typeof opts.minSessionsForAdoption !== "number" || opts.minSessionsForAdoption <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-audit.minSessionsForAdoption must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    opts.lowAdoptionThreshold !== undefined &&
    (typeof opts.lowAdoptionThreshold !== "number" ||
      opts.lowAdoptionThreshold < 0 ||
      opts.lowAdoptionThreshold > 1)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-audit.lowAdoptionThreshold must be a number between 0 and 1",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    opts.highFailureThreshold !== undefined &&
    (typeof opts.highFailureThreshold !== "number" ||
      opts.highFailureThreshold < 0 ||
      opts.highFailureThreshold > 1)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-audit.highFailureThreshold must be a number between 0 and 1",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    opts.highValueSuccessThreshold !== undefined &&
    (typeof opts.highValueSuccessThreshold !== "number" ||
      opts.highValueSuccessThreshold < 0 ||
      opts.highValueSuccessThreshold > 1)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-audit.highValueSuccessThreshold must be a number between 0 and 1",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    opts.highValueMinCalls !== undefined &&
    (typeof opts.highValueMinCalls !== "number" || opts.highValueMinCalls <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-audit.highValueMinCalls must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for tool-audit middleware.
 *
 * Creates a tool audit middleware from validated manifest options.
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-tool-audit",
  aliases: ["tool-audit"],
  optionsValidator: validateToolAuditDescriptorOptions,
  factory(options): KoiMiddleware {
    return createToolAuditMiddleware({
      ...(typeof options.unusedThresholdSessions === "number"
        ? { unusedThresholdSessions: options.unusedThresholdSessions }
        : {}),
      ...(typeof options.lowAdoptionThreshold === "number"
        ? { lowAdoptionThreshold: options.lowAdoptionThreshold }
        : {}),
      ...(typeof options.highFailureThreshold === "number"
        ? { highFailureThreshold: options.highFailureThreshold }
        : {}),
      ...(typeof options.highValueSuccessThreshold === "number"
        ? { highValueSuccessThreshold: options.highValueSuccessThreshold }
        : {}),
      ...(typeof options.highValueMinCalls === "number"
        ? { highValueMinCalls: options.highValueMinCalls }
        : {}),
      ...(typeof options.minCallsForFailure === "number"
        ? { minCallsForFailure: options.minCallsForFailure }
        : {}),
      ...(typeof options.minSessionsForAdoption === "number"
        ? { minSessionsForAdoption: options.minSessionsForAdoption }
        : {}),
    });
  },
};
