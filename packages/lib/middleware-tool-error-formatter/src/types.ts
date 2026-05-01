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
  /**
   * Additional regex patterns for secrets to sanitize. Merged with the
   * defaults (`sk-…` API keys, HTTP `Bearer` tokens) so callers cannot
   * silently disable the built-in redactions by adding their own.
   */
  readonly secretPatterns?: readonly RegExp[] | undefined;
  /**
   * When true, `secretPatterns` REPLACES `DEFAULT_SECRET_PATTERNS` instead
   * of extending it. Default: false. Setting this to true is a deliberate
   * security choice — make sure you have your own coverage for `sk-…` keys
   * and `Bearer` tokens, or pass `[]` to fully disable redaction (only
   * appropriate for tests).
   */
  readonly replaceDefaultSecretPatterns?: boolean | undefined;
  /**
   * KoiError codes whose throws propagate instead of being formatted. Empty
   * by default — error codes alone are not a trustworthy guardrail signal,
   * and a tool can legitimately surface upstream `RATE_LIMIT`/`PERMISSION`
   * as model-visible failures. The primary defense against converting
   * guardrail aborts into recoverable tool errors is priority ordering:
   * guardrails should sit OUTSIDE this formatter (priority < 170). This
   * field exists for stacks that wire a guardrail INSIDE the formatter
   * (e.g., `@koi/middleware-call-limits` at priority 175 — opt in with
   * `passthroughCodes: ["RATE_LIMIT"]`).
   */
  readonly passthroughCodes?: readonly string[] | undefined;
  /**
   * Optional predicate run for every caught error after the
   * `passthroughCodes` check. Return `true` to re-throw instead of format.
   * Use this to classify guardrail aborts that don't have a stable code —
   * e.g., a governance approval timeout where `error.context.kind === "tool"`
   * is the only reliable signal.
   *
   * The predicate must not throw; if it does, the error is formatted as
   * a fallback.
   */
  readonly passthroughPredicate?: ((error: unknown) => boolean) | undefined;
}
