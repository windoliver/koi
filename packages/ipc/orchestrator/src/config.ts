/**
 * Orchestrator configuration validation.
 */

import type { KoiError, Result } from "@koi/core";
import type { OrchestratorConfig } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validationError(message: string): {
  readonly ok: false;
  readonly error: KoiError;
} {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: false,
    },
  };
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value > 0 && Number.isInteger(value)
  );
}

/**
 * Validates an OrchestratorConfig from an unknown input.
 */
export function validateOrchestratorConfig(config: unknown): Result<OrchestratorConfig, KoiError> {
  if (!isRecord(config)) {
    return validationError("Config must be a non-null object");
  }

  if (typeof config.spawn !== "function") {
    return validationError(
      "Config requires 'spawn' as a function (request: SpawnWorkerRequest) => Promise<SpawnWorkerResult>",
    );
  }

  if (config.verify !== undefined && typeof config.verify !== "function") {
    return validationError("'verify' must be a function or undefined");
  }

  if (config.maxConcurrency !== undefined && !isPositiveInteger(config.maxConcurrency)) {
    return validationError("'maxConcurrency' must be a positive integer");
  }

  if (config.maxRetries !== undefined) {
    if (
      typeof config.maxRetries !== "number" ||
      !Number.isFinite(config.maxRetries) ||
      config.maxRetries < 0 ||
      !Number.isInteger(config.maxRetries)
    ) {
      return validationError("'maxRetries' must be a non-negative integer");
    }
  }

  if (config.maxOutputPerTask !== undefined && !isPositiveInteger(config.maxOutputPerTask)) {
    return validationError("'maxOutputPerTask' must be a positive integer");
  }

  if (config.maxDurationMs !== undefined && !isPositiveInteger(config.maxDurationMs)) {
    return validationError("'maxDurationMs' must be a positive integer");
  }

  if (
    config.maxUpstreamContextPerTask !== undefined &&
    !isPositiveInteger(config.maxUpstreamContextPerTask)
  ) {
    return validationError("'maxUpstreamContextPerTask' must be a positive integer");
  }

  if (config.onEvent !== undefined && typeof config.onEvent !== "function") {
    return validationError("'onEvent' must be a function or undefined");
  }

  const validated: unknown = config;
  return { ok: true, value: validated as OrchestratorConfig };
}
