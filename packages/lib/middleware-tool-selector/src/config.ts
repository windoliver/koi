/**
 * Configuration and validation for the tool-selector middleware.
 */

import type { InboundMessage, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { SelectToolsFn } from "./select-strategy.js";

/**
 * Public configuration for `createToolSelectorMiddleware`.
 *
 * `selectTools` is the only required field. Use one of the built-in strategy
 * factories (`createKeywordSelectTools`, `createTagSelectTools`) or supply
 * your own. All other fields have sensible defaults.
 */
export interface ToolSelectorConfig {
  /** Strategy function that picks which tools to keep on each model call. */
  readonly selectTools: SelectToolsFn;
  /** Tool names always present in the request, regardless of selection. */
  readonly alwaysInclude?: readonly string[];
  /** Cap on how many names from `selectTools` are kept. Default: 10. */
  readonly maxTools?: number;
  /** Skip filtering when the request already has at most this many tools. Default: 5. */
  readonly minTools?: number;
  /** Custom query extractor. Default: `extractLastUserText`. */
  readonly extractQuery?: (messages: readonly InboundMessage[]) => string;
  /**
   * Predicate identifying which `senderId` values count as user-authored
   * for the default `extractQuery`. Override when your channels emit
   * sender IDs outside the bundled allowlist (`user`, `user-<n>`,
   * `cli-user`, `cli-user-<n>`) — otherwise the selector silently
   * skips filtering and re-exposes the full tool set
   * (#review-round19-F1). Ignored when `extractQuery` is also supplied.
   */
  readonly isUserSender?: (senderId: string) => boolean;
  /** Optional error sink invoked when `selectTools` throws (fail-open path). */
  readonly onError?: (error: unknown) => void;
  /**
   * When `true` (default), `wrapToolCall` rejects any tool whose name was
   * filtered out for the current turn. This makes the selector a real
   * trust boundary — useful for tag-based profiles that exclude dangerous
   * tools, or when defending against prompt injection / model
   * hallucinations of unseen tool names.
   *
   * Set `false` if the selector is purely a token-saving prompt filter and
   * you want the model to still be able to invoke tools that were hidden
   * from the prompt.
   */
  readonly enforceFiltering?: boolean;
  /**
   * Policy for multimodal user turns (latest user message has at least one
   * non-text content block). The bundled extractor returns "" for these,
   * so the selector cannot derive intent from text. Default
   * `"fail-closed"`: collapse to `alwaysInclude`, matching the
   * untrusted-provenance fallback. Set `"pass-through"` to opt into the
   * round-31 behavior of authorizing the full advertised tool set —
   * suitable only when downstream policy already gates dangerous tools
   * for multimodal turns (#review-round35-F1).
   */
  readonly multimodalPolicy?: "fail-closed" | "pass-through";
}

/** Default cap on `selectTools` results — prevents runaway tool counts on large agents. */
export const DEFAULT_MAX_TOOLS = 10;
/** Default skip threshold — agents with <= 5 tools don't benefit from filtering. */
export const DEFAULT_MIN_TOOLS = 5;

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

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

/**
 * Validates a `ToolSelectorConfig`. Returns `Result<ToolSelectorConfig, KoiError>` —
 * never throws. The factory invokes this and converts any error into a
 * `KoiRuntimeError` for the caller.
 */
export function validateToolSelectorConfig(config: unknown): Result<ToolSelectorConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }
  const c = config as Record<string, unknown>;

  if (typeof c.selectTools !== "function") {
    return validationError("'selectTools' must be a function");
  }
  if (c.alwaysInclude !== undefined && !isStringArray(c.alwaysInclude)) {
    return validationError("'alwaysInclude' must be an array of strings");
  }
  if (c.maxTools !== undefined && !isPositiveInteger(c.maxTools)) {
    return validationError("'maxTools' must be a positive integer");
  }
  if (c.minTools !== undefined && !isNonNegativeInteger(c.minTools)) {
    return validationError("'minTools' must be a non-negative integer");
  }
  if (c.extractQuery !== undefined && typeof c.extractQuery !== "function") {
    return validationError("'extractQuery' must be a function");
  }
  if (c.isUserSender !== undefined && typeof c.isUserSender !== "function") {
    return validationError("'isUserSender' must be a function");
  }
  if (c.onError !== undefined && typeof c.onError !== "function") {
    return validationError("'onError' must be a function");
  }
  if (c.enforceFiltering !== undefined && typeof c.enforceFiltering !== "boolean") {
    return validationError("'enforceFiltering' must be a boolean");
  }
  if (
    c.multimodalPolicy !== undefined &&
    c.multimodalPolicy !== "fail-closed" &&
    c.multimodalPolicy !== "pass-through"
  ) {
    return validationError("'multimodalPolicy' must be 'fail-closed' or 'pass-through'");
  }

  return { ok: true, value: c as unknown as ToolSelectorConfig };
}
