/**
 * Exec tool factory — creates a Tool that runs code in a sandboxed executor.
 */

import type { JsonObject } from "@koi/core/common";
import type { Tool, ToolExecuteOptions } from "@koi/core/ecs";
import type { ExecutionContext } from "@koi/core/sandbox-executor";
import {
  DEFAULT_TIMEOUT_MS,
  EXEC_TOOL_DESCRIPTOR,
  type ExecToolConfig,
  MAX_TIMEOUT_MS,
} from "./types.js";

/**
 * Creates the `exec` tool — a thin pass-through to `SandboxExecutor.execute()`.
 *
 * The tool validates input, clamps the timeout, builds an `ExecutionContext`
 * from the config, and delegates to the executor.
 */
export function createExecTool(config: ExecToolConfig): Tool {
  const defaultTimeout = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeout = config.maxTimeoutMs ?? MAX_TIMEOUT_MS;

  const context: ExecutionContext = {
    ...(config.networkAllowed !== undefined ? { networkAllowed: config.networkAllowed } : {}),
    ...(config.resourceLimits !== undefined ? { resourceLimits: config.resourceLimits } : {}),
  };

  return {
    descriptor: EXEC_TOOL_DESCRIPTOR,
    trustTier: "sandbox",

    async execute(args: JsonObject, _options?: ToolExecuteOptions): Promise<unknown> {
      const code = args.code;
      if (typeof code !== "string" || code.length === 0) {
        return { ok: false, error: "Missing or empty `code` parameter", code: "VALIDATION" };
      }

      const rawTimeout = args.timeout_ms;
      const requestedTimeout =
        typeof rawTimeout === "number" && rawTimeout > 0 ? rawTimeout : defaultTimeout;
      const timeoutMs = Math.min(requestedTimeout, maxTimeout);

      const input: unknown = args.input ?? null;

      // let justified: assigned in try, used after catch for result mapping
      let result: Awaited<ReturnType<typeof config.executor.execute>>;
      try {
        result = await config.executor.execute(code, input, timeoutMs, context);
      } catch (e: unknown) {
        const message =
          e instanceof Error ? e.message : "Sandbox executor threw an unexpected error";
        return { ok: false, error: message, code: "CRASH" };
      }

      if (result.ok) {
        return {
          ok: true,
          output: result.value.output,
          durationMs: result.value.durationMs,
        };
      }

      return {
        ok: false,
        error: result.error.message,
        code: result.error.code,
        durationMs: result.error.durationMs,
      };
    },
  };
}
