/**
 * RLM middleware configuration validation.
 *
 * Manual type guards — no Zod dependency.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { RlmMiddlewareConfig } from "./types.js";

function validationError(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

function isFinitePositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFractionOrUndefined(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}

/**
 * Validate an unknown value as RlmMiddlewareConfig.
 *
 * Returns `{ ok: true, value }` on success or `{ ok: false, error }` on failure.
 */
export function validateRlmConfig(config: unknown): Result<RlmMiddlewareConfig, KoiError> {
  if (config === null || config === undefined) {
    return { ok: true, value: {} };
  }

  if (typeof config !== "object") {
    return validationError("RLM config must be an object");
  }

  const c = config as Record<string, unknown>;

  if (c.priority !== undefined && !isFinitePositive(c.priority)) {
    return validationError("'priority' must be a positive finite number");
  }

  if (c.maxIterations !== undefined && !isFinitePositive(c.maxIterations)) {
    return validationError("'maxIterations' must be a positive finite number");
  }

  if (c.maxInputBytes !== undefined && !isFinitePositive(c.maxInputBytes)) {
    return validationError("'maxInputBytes' must be a positive finite number");
  }

  if (c.chunkSize !== undefined && !isFinitePositive(c.chunkSize)) {
    return validationError("'chunkSize' must be a positive finite number");
  }

  if (c.previewLength !== undefined && !isFinitePositive(c.previewLength)) {
    return validationError("'previewLength' must be a positive finite number");
  }

  if (!isFractionOrUndefined(c.compactionThreshold)) {
    return validationError("'compactionThreshold' must be a number between 0 and 1");
  }

  if (c.contextWindowTokens !== undefined && !isFinitePositive(c.contextWindowTokens)) {
    return validationError("'contextWindowTokens' must be a positive finite number");
  }

  if (c.maxConcurrency !== undefined && !isFinitePositive(c.maxConcurrency)) {
    return validationError("'maxConcurrency' must be a positive finite number");
  }

  if (c.rootModel !== undefined && typeof c.rootModel !== "string") {
    return validationError("'rootModel' must be a string");
  }

  if (c.subCallModel !== undefined && typeof c.subCallModel !== "string") {
    return validationError("'subCallModel' must be a string");
  }

  if (c.spawnRlmChild !== undefined && typeof c.spawnRlmChild !== "function") {
    return validationError("'spawnRlmChild' must be a function");
  }

  if (c.depth !== undefined && (typeof c.depth !== "number" || c.depth < 0)) {
    return validationError("'depth' must be a non-negative number");
  }

  if (c.onEvent !== undefined && typeof c.onEvent !== "function") {
    return validationError("'onEvent' must be a function");
  }

  if (c.scriptRunner !== undefined) {
    if (typeof c.scriptRunner !== "object" || c.scriptRunner === null) {
      return validationError("'scriptRunner' must be an object with a 'run' method");
    }
    const runner = c.scriptRunner as Record<string, unknown>;
    if (typeof runner.run !== "function") {
      return validationError("'scriptRunner.run' must be a function");
    }
  }

  return { ok: true, value: config as RlmMiddlewareConfig };
}
