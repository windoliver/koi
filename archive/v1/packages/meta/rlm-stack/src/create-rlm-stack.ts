/**
 * RLM stack factory — wires @koi/code-executor into @koi/middleware-rlm.
 *
 * Creates a script runner and passes it to createRlmBundle, returning
 * a MiddlewareBundle ready for agent assembly.
 */

import type { MiddlewareBundle } from "@koi/core";
import { createRlmBundle } from "@koi/middleware-rlm";
import { createScriptRunner } from "./create-script-runner.js";
import type { RlmStackConfig } from "./types.js";

/**
 * Creates an RLM middleware bundle with code-execution mode enabled.
 *
 * The model writes JavaScript code blocks that are executed in a QuickJS
 * WASM sandbox with host functions for input access and sub-LLM queries.
 *
 * @example
 * ```typescript
 * const { middleware, providers } = createRlmStack({
 *   contextWindowTokens: 128_000,
 *   maxIterations: 30,
 * });
 * ```
 */
export function createRlmStack(config?: RlmStackConfig): MiddlewareBundle {
  const scriptRunner = createScriptRunner({
    timeoutMs: config?.scriptTimeoutMs,
    maxCalls: config?.scriptMaxCalls,
  });

  return createRlmBundle({
    ...config,
    scriptRunner,
  });
}
