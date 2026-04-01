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
}
