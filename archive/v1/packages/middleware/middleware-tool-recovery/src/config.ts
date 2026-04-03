/**
 * Tool recovery middleware configuration and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { RecoveryEvent, ToolCallPattern } from "./types.js";

/** Default maximum tool calls recovered from a single response. */
export const DEFAULT_MAX_TOOL_CALLS = 10;

/** Default built-in pattern names applied when none specified. */
export const DEFAULT_PATTERN_NAMES: readonly string[] = ["hermes", "llama31", "json-fence"];

/** Valid built-in pattern name strings. */
const VALID_PATTERN_NAMES = new Set<string>(["hermes", "llama31", "json-fence"]);

export interface ToolRecoveryConfig {
  /** Pattern names (string) or custom patterns (ToolCallPattern). Default: all built-in patterns. */
  readonly patterns?: readonly (string | ToolCallPattern)[] | undefined;
  /** Maximum tool calls to extract from a single response. Default: 10. */
  readonly maxToolCallsPerResponse?: number | undefined;
  /** Callback for recovery observability events. */
  readonly onRecoveryEvent?: ((event: RecoveryEvent) => void) | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validationError(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: { code: "VALIDATION", message, retryable: RETRYABLE_DEFAULTS.VALIDATION },
  };
}

function isToolCallPattern(value: unknown): value is ToolCallPattern {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" && typeof value.detect === "function";
}

export function validateToolRecoveryConfig(config: unknown): Result<ToolRecoveryConfig, KoiError> {
  if (!isRecord(config)) {
    return validationError("Config must be a non-null object");
  }

  if (config.patterns !== undefined) {
    if (!Array.isArray(config.patterns)) {
      return validationError("'patterns' must be an array");
    }
    for (const entry of config.patterns as unknown[]) {
      if (typeof entry === "string") {
        if (!VALID_PATTERN_NAMES.has(entry)) {
          return validationError(
            `Unknown pattern name "${entry}". Valid: ${[...VALID_PATTERN_NAMES].join(", ")}`,
          );
        }
      } else if (!isToolCallPattern(entry)) {
        return validationError(
          "Each pattern must be a valid pattern name string or a ToolCallPattern object with 'name' and 'detect'",
        );
      }
    }
  }

  if (config.maxToolCallsPerResponse !== undefined) {
    if (
      typeof config.maxToolCallsPerResponse !== "number" ||
      !Number.isInteger(config.maxToolCallsPerResponse) ||
      config.maxToolCallsPerResponse <= 0
    ) {
      return validationError("maxToolCallsPerResponse must be a positive integer");
    }
  }

  if (config.onRecoveryEvent !== undefined && typeof config.onRecoveryEvent !== "function") {
    return validationError("onRecoveryEvent must be a function");
  }

  return { ok: true, value: config as ToolRecoveryConfig };
}
