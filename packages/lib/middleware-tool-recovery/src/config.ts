/**
 * Configuration and validation for the tool-recovery middleware.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { RecoveryEvent, ToolCallPattern } from "./types.js";

/** Default cap on tool calls extracted from a single response. */
export const DEFAULT_MAX_TOOL_CALLS = 10;

/**
 * Default built-in pattern names (applied when `config.patterns` is omitted).
 *
 * `json-fence` is intentionally NOT in the defaults: any model output that
 * contains a fenced JSON snippet with `name`/`arguments` fields (a code
 * example, schema fragment, or quoted payload) would otherwise be promoted
 * to a live tool call. Callers must opt in explicitly when their model is
 * known to use plain `json` fences as the actual tool-invocation channel.
 */
export const DEFAULT_PATTERN_NAMES: readonly string[] = ["hermes", "llama31"];

/** Built-in pattern names accepted as strings in `config.patterns`. */
const VALID_PATTERN_NAMES: ReadonlySet<string> = new Set<string>([
  "hermes",
  "llama31",
  "json-fence",
]);

/**
 * Public configuration for `createToolRecoveryMiddleware`.
 *
 * All fields are optional. With no config the middleware applies all three
 * built-in patterns and caps recovered calls at {@link DEFAULT_MAX_TOOL_CALLS}.
 */
export interface ToolRecoveryConfig {
  /** Pattern names (string) or custom patterns. Default: all built-in patterns. */
  readonly patterns?: readonly (string | ToolCallPattern)[] | undefined;
  /** Maximum tool calls to extract from a single response. Default: 10. */
  readonly maxToolCallsPerResponse?: number | undefined;
  /** Callback for recovery observability events (recovered / rejected / parse_error). */
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

function validatePatternsField(patterns: unknown): Result<undefined, KoiError> {
  if (!Array.isArray(patterns)) {
    return validationError("'patterns' must be an array");
  }
  for (const entry of patterns as readonly unknown[]) {
    if (typeof entry === "string") {
      if (!VALID_PATTERN_NAMES.has(entry)) {
        return validationError(
          `Unknown pattern name "${entry}". Valid: ${[...VALID_PATTERN_NAMES].join(", ")}`,
        );
      }
    } else if (!isToolCallPattern(entry)) {
      return validationError(
        "Each pattern entry must be a built-in pattern name string or an object with 'name' and 'detect'",
      );
    }
  }
  return { ok: true, value: undefined };
}

/**
 * Validates a `ToolRecoveryConfig`. Returns `Result<ToolRecoveryConfig, KoiError>` —
 * never throws. The factory invokes this and converts any error into a
 * `KoiRuntimeError` for the caller.
 */
export function validateToolRecoveryConfig(config: unknown): Result<ToolRecoveryConfig, KoiError> {
  if (config === undefined) {
    return { ok: true, value: {} };
  }
  if (!isRecord(config)) {
    return validationError("Config must be a non-null object");
  }

  if (config.patterns !== undefined) {
    const result = validatePatternsField(config.patterns);
    if (!result.ok) return result;
  }

  if (config.maxToolCallsPerResponse !== undefined) {
    const m = config.maxToolCallsPerResponse;
    if (typeof m !== "number" || !Number.isInteger(m) || m <= 0) {
      return validationError("'maxToolCallsPerResponse' must be a positive integer");
    }
  }

  if (config.onRecoveryEvent !== undefined && typeof config.onRecoveryEvent !== "function") {
    return validationError("'onRecoveryEvent' must be a function");
  }

  return { ok: true, value: config as ToolRecoveryConfig };
}
