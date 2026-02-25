/**
 * Parallel minions configuration validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { ParallelMinionsConfig } from "./types.js";
import { DEFAULT_MAX_CONCURRENCY } from "./types.js";

const VALID_STRATEGIES: ReadonlySet<string> = new Set<string>([
  "best-effort",
  "fail-fast",
  "quorum",
]);

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

function isFinitePositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value > 0 && Number.isInteger(value)
  );
}

/**
 * Validates a ParallelMinionsConfig from an unknown input.
 *
 * Checks:
 * - `agents` is a Map with at least one entry (each with name, description, manifest)
 * - `spawn` is a function
 * - `defaultAgent` (if provided) references a key in `agents`
 * - `maxConcurrency` (if provided) is a finite positive integer
 * - `maxDurationMs` (if provided) is a finite positive integer
 * - `maxOutputPerTask` (if provided) is a finite positive integer
 * - `maxTotalOutput` (if provided) is a finite positive integer
 * - `strategy` (if provided) is one of "best-effort" | "fail-fast" | "quorum"
 * - `quorumThreshold` is required when strategy = "quorum" and must be a positive integer
 */
export function validateParallelMinionsConfig(
  config: unknown,
): Result<ParallelMinionsConfig, KoiError> {
  if (!isRecord(config)) {
    return validationError("Config must be a non-null object");
  }

  if (typeof config.spawn !== "function") {
    return validationError(
      "Config requires 'spawn' as a function (request: MinionSpawnRequest) => Promise<MinionSpawnResult>",
    );
  }

  if (!(config.agents instanceof Map)) {
    return validationError("Config requires 'agents' as a Map<string, MinionableAgent>");
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

  if (config.maxConcurrency !== undefined) {
    if (!isFinitePositiveInteger(config.maxConcurrency)) {
      return validationError("'maxConcurrency' must be a finite positive integer");
    }
  }

  if (config.maxDurationMs !== undefined) {
    if (!isFinitePositiveInteger(config.maxDurationMs)) {
      return validationError("'maxDurationMs' must be a finite positive integer");
    }
  }

  if (config.maxOutputPerTask !== undefined) {
    if (!isFinitePositiveInteger(config.maxOutputPerTask)) {
      return validationError("'maxOutputPerTask' must be a finite positive integer");
    }
  }

  if (config.maxTotalOutput !== undefined) {
    if (!isFinitePositiveInteger(config.maxTotalOutput)) {
      return validationError("'maxTotalOutput' must be a finite positive integer");
    }
  }

  if (config.laneConcurrency !== undefined) {
    if (!(config.laneConcurrency instanceof Map)) {
      return validationError("'laneConcurrency' must be a Map<string, number>");
    }
    for (const [key, value] of config.laneConcurrency as Map<unknown, unknown>) {
      if (typeof key !== "string") {
        return validationError(`laneConcurrency key must be a string, got ${typeof key}`);
      }
      if (!(config.agents as Map<string, unknown>).has(key)) {
        return validationError(`laneConcurrency key '${key}' must reference a key in 'agents'`);
      }
      if (!isFinitePositiveInteger(value)) {
        return validationError(
          `laneConcurrency value for '${key}' must be a finite positive integer`,
        );
      }
      const effectiveMax = isFinitePositiveInteger(config.maxConcurrency)
        ? (config.maxConcurrency as number)
        : DEFAULT_MAX_CONCURRENCY;
      if ((value as number) > effectiveMax) {
        return validationError(
          `laneConcurrency['${key}'] (${String(value)}) exceeds maxConcurrency (${String(effectiveMax)})`,
        );
      }
    }
  }

  if (config.strategy !== undefined) {
    if (typeof config.strategy !== "string" || !VALID_STRATEGIES.has(config.strategy)) {
      return validationError(`'strategy' must be one of: ${[...VALID_STRATEGIES].join(", ")}`);
    }

    if (config.strategy === "quorum") {
      if (config.quorumThreshold === undefined) {
        return validationError("'quorumThreshold' is required when strategy is 'quorum'");
      }
      if (!isFinitePositiveInteger(config.quorumThreshold)) {
        return validationError("'quorumThreshold' must be a finite positive integer");
      }
    }
  }

  const validated: unknown = config;
  return { ok: true, value: validated as ParallelMinionsConfig };
}
