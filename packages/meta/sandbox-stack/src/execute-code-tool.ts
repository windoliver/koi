/**
 * execute_code tool provider for the sandbox stack.
 *
 * Wraps a SandboxStack.executor as a Koi ComponentProvider that
 * attaches an "execute_code" tool to any agent.
 */

import type { ComponentProvider, JsonObject, Tool, ToolExecuteOptions } from "@koi/core";
import { createSingleToolProvider } from "@koi/core";
import type { SandboxStack } from "./types.js";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Create a ComponentProvider that attaches an "execute_code" tool.
 *
 * The tool delegates to the stack's timeout-guarded executor.
 */
export function createExecuteCodeProvider(stack: SandboxStack): ComponentProvider {
  return createSingleToolProvider({
    name: "sandbox-stack",
    toolName: "execute_code",
    createTool: (): Tool => ({
      descriptor: {
        name: "execute_code",
        description: "Execute code in a sandboxed environment",
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string", description: "The code to execute" },
            language: {
              type: "string",
              description: "Programming language (e.g., 'python', 'javascript', 'sh')",
            },
            input: { description: "Optional input data passed to the code" },
            timeoutMs: {
              type: "number",
              description: "Execution timeout in milliseconds",
            },
          },
          required: ["code"],
        },
      },
      trustTier: "sandbox",
      execute: async (args: JsonObject, _options?: ToolExecuteOptions): Promise<unknown> => {
        const code = typeof args.code === "string" ? args.code : String(args.code);
        const input = args.input ?? null;
        const timeoutMs =
          typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_TOOL_TIMEOUT_MS;

        const result = await stack.executor.execute(code, input, timeoutMs);

        if (result.ok) {
          return { output: result.value.output };
        }
        return { error: result.error.message };
      },
    }),
  });
}
