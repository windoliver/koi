/**
 * Eval config validation and defaults.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { EvalRunConfig } from "./types.js";

export const DEFAULT_CONCURRENCY = 5;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_PASS_THRESHOLD = 0.5;

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
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

function validateTask(task: unknown): string | undefined {
  if (!isRecord(task)) return "Each task must be a non-null object";
  if (typeof task.id !== "string" || task.id.length === 0) {
    return "Each task must have a non-empty 'id' string";
  }
  if (typeof task.name !== "string" || task.name.length === 0) {
    return "Each task must have a non-empty 'name' string";
  }
  if (!isRecord(task.input) || typeof task.input.kind !== "string") {
    return `Task "${String(task.id)}": 'input' must have a 'kind' field`;
  }
  if (!Array.isArray(task.graders) || task.graders.length === 0) {
    return `Task "${String(task.id)}": 'graders' must be a non-empty array`;
  }
  if (task.trialCount !== undefined) {
    if (
      typeof task.trialCount !== "number" ||
      !Number.isInteger(task.trialCount) ||
      task.trialCount < 1
    ) {
      return `Task "${String(task.id)}": 'trialCount' must be a positive integer`;
    }
  }
  if (task.timeoutMs !== undefined) {
    if (
      typeof task.timeoutMs !== "number" ||
      !Number.isFinite(task.timeoutMs) ||
      task.timeoutMs <= 0
    ) {
      return `Task "${String(task.id)}": 'timeoutMs' must be a finite positive number`;
    }
  }
  return undefined;
}

function validateOptionalFields(config: Record<string, unknown>): string | undefined {
  if (config.concurrency !== undefined) {
    if (
      typeof config.concurrency !== "number" ||
      !Number.isInteger(config.concurrency) ||
      config.concurrency < 1
    ) {
      return "'concurrency' must be a positive integer";
    }
  }
  if (config.timeoutMs !== undefined) {
    if (
      typeof config.timeoutMs !== "number" ||
      !Number.isFinite(config.timeoutMs) ||
      config.timeoutMs <= 0
    ) {
      return "'timeoutMs' must be a finite positive number";
    }
  }
  if (config.passThreshold !== undefined) {
    if (
      typeof config.passThreshold !== "number" ||
      config.passThreshold < 0 ||
      config.passThreshold > 1
    ) {
      return "'passThreshold' must be a number between 0 and 1";
    }
  }
  if (config.onTrialComplete !== undefined && typeof config.onTrialComplete !== "function") {
    return "'onTrialComplete' must be a function";
  }
  return undefined;
}

export function validateEvalConfig(config: unknown): Result<EvalRunConfig, KoiError> {
  if (!isRecord(config)) return validationError("Config must be a non-null object");
  if (typeof config.name !== "string" || config.name.length === 0) {
    return validationError("'name' must be a non-empty string");
  }
  if (!Array.isArray(config.tasks) || config.tasks.length === 0) {
    return validationError("'tasks' must be a non-empty array");
  }

  for (const task of config.tasks as unknown[]) {
    const taskError = validateTask(task);
    if (taskError !== undefined) return validationError(taskError);
  }

  if (typeof config.agentFactory !== "function") {
    return validationError("'agentFactory' must be a function");
  }

  const optionalError = validateOptionalFields(config);
  if (optionalError !== undefined) return validationError(optionalError);

  const validated: unknown = config;
  return { ok: true, value: validated as EvalRunConfig };
}
