/**
 * Configuration types for @koi/rlm-stack.
 */

import type { RlmMiddlewareConfig } from "@koi/middleware-rlm";

/**
 * Configuration for the RLM stack.
 *
 * Extends RlmMiddlewareConfig with script execution options.
 * The `scriptRunner` field is NOT included here — it is created
 * internally by `createRlmStack`.
 */
export interface RlmStackConfig extends Omit<RlmMiddlewareConfig, "scriptRunner"> {
  /** Execution timeout per script run in milliseconds. Default: 30_000. */
  readonly scriptTimeoutMs?: number | undefined;
  /** Maximum host function calls per script execution. Default: 100. */
  readonly scriptMaxCalls?: number | undefined;
}
