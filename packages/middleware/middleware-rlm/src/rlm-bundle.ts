/**
 * RLM bundle — packages RLM middleware + rlm_process tool provider.
 *
 * The bundle factory creates both and wires them together. The
 * ComponentProvider attaches `tool:rlm_process` to the agent entity
 * for ECS discoverability.
 */

import type { MiddlewareBundle, Tool } from "@koi/core";
import { createSingleToolProvider } from "@koi/core";
import { createRlmMiddleware } from "./rlm.js";
import { RLM_PROCESS_DESCRIPTOR, RLM_PROCESS_TOOL_NAME } from "./rlm-tool-descriptor.js";
import type { RlmMiddlewareConfig } from "./types.js";

/**
 * Creates a Tool wrapper that represents the rlm_process capability.
 *
 * This Tool is for ECS registration — the actual execution is handled
 * by the middleware's wrapToolCall. The Tool.execute simply returns an
 * error directing callers to use the middleware pipeline instead.
 */
function createRlmProcessTool(): Tool {
  return {
    descriptor: RLM_PROCESS_DESCRIPTOR,
    trustTier: "verified",
    execute: async () => ({
      error: "rlm_process must be invoked through the middleware pipeline, not directly",
      code: "RLM_ERROR",
    }),
  };
}

/**
 * Creates an RLM middleware bundle with ECS tool registration.
 *
 * Returns:
 * - `middleware`: The KoiMiddleware that intercepts rlm_process calls
 * - `providers`: ComponentProvider that attaches tool:rlm_process to the agent
 */
export function createRlmBundle(config?: RlmMiddlewareConfig): MiddlewareBundle {
  const middleware = createRlmMiddleware(config);

  const provider = createSingleToolProvider({
    name: "rlm-tool-provider",
    toolName: RLM_PROCESS_TOOL_NAME,
    createTool: () => createRlmProcessTool(),
  });

  return { middleware, providers: [provider] };
}
