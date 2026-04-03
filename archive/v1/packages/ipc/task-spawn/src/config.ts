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

/** Structural type guard for Map-like objects (accepts Map and ReadonlyMap). */
function isMapLike(value: unknown): value is ReadonlyMap<unknown, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).get === "function" &&
    typeof (value as Record<string, unknown>).has === "function" &&
    typeof (value as Record<string, unknown>).size === "number" &&
    typeof (value as Record<string, unknown>).entries === "function"
  );
}

function validateAgentsMap(
  agents: ReadonlyMap<unknown, unknown>,
): ReturnType<typeof validationError> | undefined {
  if (agents.size === 0) {
    return validationError("Config requires at least one agent in the 'agents' map");
  }

  for (const [key, value] of agents) {
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
  return undefined;
}

/**
 * Validates a TaskSpawnConfig from an unknown input.
 *
 * Checks:
 * - Either `agents` (Map with >=1 entry) or `agentResolver` (with resolve + list) is provided
 * - `spawn` is a function
 * - `defaultAgent` (if provided) is a string
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

  const hasAgents = isMapLike(config.agents);
  const hasResolver =
    isRecord(config.agentResolver) &&
    typeof config.agentResolver.resolve === "function" &&
    typeof config.agentResolver.list === "function";

  if (!hasAgents && !hasResolver) {
    return validationError(
      "Config requires either 'agents' (Map<string, TaskableAgent>) or 'agentResolver' (AgentResolver with resolve + list)",
    );
  }

  if (hasAgents) {
    const mapError = validateAgentsMap(config.agents as ReadonlyMap<unknown, unknown>);
    if (mapError !== undefined) return mapError;
  }

  if (config.defaultAgent !== undefined) {
    if (typeof config.defaultAgent !== "string") {
      return validationError("'defaultAgent' must be a string");
    }
    // When using agentResolver, we can't validate defaultAgent against static map
    if (hasAgents && !(config.agents as ReadonlyMap<string, unknown>).has(config.defaultAgent)) {
      return validationError(
        `'defaultAgent' value '${config.defaultAgent}' must reference a key in 'agents'`,
      );
    }
  }

  if (config.message !== undefined && typeof config.message !== "function") {
    return validationError("'message' must be a function if provided");
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
