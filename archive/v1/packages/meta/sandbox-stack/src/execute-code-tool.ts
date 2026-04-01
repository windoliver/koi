/**
 * execute_code tool provider for the sandbox stack.
 *
 * Wraps a SandboxStack.executor as a Koi ComponentProvider that
 * attaches an "execute_code" tool to any agent.
 */

import type { ComponentProvider, JsonObject, Tool, ToolExecuteOptions } from "@koi/core";
import { createSingleToolProvider, DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import type { SandboxStack } from "./types.js";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

/** Options for createExecuteCodeProvider. */
export interface ExecuteCodeProviderOptions {
  /**
   * Maximum output size in bytes. Output exceeding this limit is truncated
   * with a notice appended. Default: 10 MB.
   */
  readonly maxOutputBytes?: number | undefined;
}

/**
 * Truncate string output to the given byte limit.
 * Returns the original value unchanged if it is not a string or fits within the limit.
 */
function truncateOutput(output: unknown, maxBytes: number): unknown {
  if (typeof output !== "string") {
    return output;
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(output);
  if (bytes.byteLength <= maxBytes) {
    return output;
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const truncated = decoder.decode(bytes.slice(0, maxBytes));
  return `${truncated}\n\n[output truncated — exceeded ${String(maxBytes)} byte limit]`;
}

/**
 * Create a ComponentProvider that attaches an "execute_code" tool.
 *
 * The tool delegates to the stack's timeout-guarded executor.
 *
 * Note: The SandboxExecutor interface (L0) does not accept a `language`
 * parameter. The tool schema therefore omits `language` — the sandbox
 * backend determines the execution environment, not the caller.
 */
export function createExecuteCodeProvider(
  stack: SandboxStack,
  options?: ExecuteCodeProviderOptions,
): ComponentProvider {
  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

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
            input: { description: "Optional input data passed to the code" },
            timeoutMs: {
              type: "number",
              description: "Execution timeout in milliseconds",
            },
          },
          required: ["code"],
        },
      },
      origin: "primordial",
      policy: DEFAULT_SANDBOXED_POLICY,
      execute: async (args: JsonObject, _options?: ToolExecuteOptions): Promise<unknown> => {
        const code = typeof args.code === "string" ? args.code : String(args.code);
        const input = args.input ?? null;
        const timeoutMs =
          typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_TOOL_TIMEOUT_MS;

        const result = await stack.executor.execute(code, input, timeoutMs);

        if (result.ok) {
          return { output: truncateOutput(result.value.output, maxOutputBytes) };
        }
        return { error: result.error.message };
      },
    }),
  });
}
