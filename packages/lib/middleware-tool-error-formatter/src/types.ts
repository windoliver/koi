/**
 * Types for the tool error formatter middleware.
 */

import type { JsonObject, KoiError } from "@koi/core";

/** Custom formatter function for tool errors. */
export type ToolErrorFormatter = (
  error: KoiError,
  toolId: string,
  input: JsonObject,
) => string | Promise<string>;

export interface ToolErrorFormatterConfig {
  /** Custom formatter. Falls back to default if this throws or returns non-string. */
  readonly formatter?: ToolErrorFormatter | undefined;
  /** Maximum error message length before truncation. Default: 1000. */
  readonly maxMessageLength?: number | undefined;
  /** Regex patterns for secrets to sanitize from error messages. */
  readonly secretPatterns?: readonly RegExp[] | undefined;
  /**
   * KoiError codes that should propagate as throws instead of being formatted
   * into a ToolResponse. These represent guardrail / control-flow aborts that
   * the engine must see as failures (e.g., `RATE_LIMIT` from
   * `@koi/middleware-call-limits` with `exitBehavior: "error"`, `PERMISSION`
   * from a deny-by-default permissions middleware).
   *
   * Default: `["RATE_LIMIT", "PERMISSION"]`. Pass an empty array to format
   * every error (the legacy behavior); pass a wider set to harden against
   * additional guardrail middleware in your stack.
   */
  readonly passthroughCodes?: readonly string[] | undefined;
}
