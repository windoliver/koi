/**
 * ComponentProvider that registers `write_plan` with the agent's tool
 * registry. Required alongside the planning middleware so that the
 * query-engine's advertised-tool snapshot includes `write_plan` and does
 * not reject model-issued calls as undeclared.
 *
 * The provider's execute() is a defensive fallback: if the middleware is
 * not registered, the tool returns a clear error instead of silently
 * committing plan state. In normal operation the middleware intercepts
 * the call before it reaches execute().
 */

import type { ComponentProvider, JsonObject, Tool, ToolExecuteOptions } from "@koi/core";
import { createSingleToolProvider, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { WRITE_PLAN_DESCRIPTOR, WRITE_PLAN_TOOL_NAME } from "./plan-tool.js";

export function createPlanToolProvider(): ComponentProvider {
  return createSingleToolProvider({
    name: "plan-tool",
    toolName: WRITE_PLAN_TOOL_NAME,
    createTool: (): Tool => ({
      descriptor: WRITE_PLAN_DESCRIPTOR,
      origin: "primordial",
      policy: DEFAULT_UNSANDBOXED_POLICY,
      execute: async (_args: JsonObject, _options?: ToolExecuteOptions): Promise<unknown> => ({
        error:
          "write_plan was invoked but @koi/middleware-planning is not registered; add createPlanMiddleware() to the middleware chain",
      }),
    }),
  });
}
