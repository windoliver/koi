/**
 * Task spawn configuration validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { TaskSpawnConfig } from "./types.js";

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

/**
 * Validates a TaskSpawnConfig from an unknown input.
 *
 * Checks:
 * - `agents` is a Map with at least one entry (each with name, description, manifest)
 * - `spawn` is a function
 * - `defaultAgent` (if provided) references a key in `agents`
 * - `maxDurationMs` (if provided) is a finite positive integer
 */
export function validateTaskSpawnConfig(config: unknown): Result<TaskSpawnConfig, KoiError> {
  if (!isRecord(config)) {
    return validationError("Config must be a non-null object");
  }

  if (typeof config.spawn !== "function") {
    return validationError(
      "Config requires 'spawn' as a function (request: TaskSpawnRequest) => Promise<TaskSpawnResult>",
    );
  }

  if (!(config.agents instanceof Map)) {
    return validationError("Config requires 'agents' as a Map<string, TaskableAgent>");
  }

  if (config.agents.size === 0) {
    return validationError("Config requires at least one agent in the 'agents' map");
  }

  for (const [key, value] of config.agents as Map<unknown, unknown>) {
    if (typeof key !== "string") {
      return validationError(`Agent map key must be a string, got ${typeof key}`);
    }
    if (!isRecord(value)) {
      return validationError(
        `Agent '${key}' must be a non-null object with name, description, and manifest`,
      );
    }
    if (typeof value.name !== "string" || value.name.length === 0) {
      return validationError(`Agent '${key}' requires a non-empty 'name' string`);
    }
    if (typeof value.description !== "string" || value.description.length === 0) {
      return validationError(`Agent '${key}' requires a non-empty 'description' string`);
    }
    if (!isRecord(value.manifest)) {
      return validationError(`Agent '${key}' requires a 'manifest' object (AgentManifest)`);
    }
  }

  if (config.defaultAgent !== undefined) {
    if (typeof config.defaultAgent !== "string") {
      return validationError("'defaultAgent' must be a string");
    }
    if (!(config.agents as Map<string, unknown>).has(config.defaultAgent)) {
      return validationError(
        `'defaultAgent' value '${config.defaultAgent}' must reference a key in 'agents'`,
      );
    }
  }

  if (config.maxDurationMs !== undefined) {
    if (
      typeof config.maxDurationMs !== "number" ||
      !Number.isFinite(config.maxDurationMs) ||
      config.maxDurationMs <= 0 ||
      !Number.isInteger(config.maxDurationMs)
    ) {
      return validationError("'maxDurationMs' must be a finite positive integer");
    }
  }

  const validated: unknown = config;
  return { ok: true, value: validated as TaskSpawnConfig };
}
