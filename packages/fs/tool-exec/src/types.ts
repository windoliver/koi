/**
 * Configuration types for the exec tool.
 */

import type { ToolDescriptor } from "@koi/core/ecs";
import type { ExecutionContext, SandboxExecutor } from "@koi/core/sandbox-executor";

/** Configuration for creating an exec tool instance. */
export interface ExecToolConfig {
  /** The sandbox executor backend to delegate code execution to. */
  readonly executor: SandboxExecutor;
  /** Default timeout in milliseconds when the model omits `timeout_ms`. Default: 5000. */
  readonly defaultTimeoutMs?: number | undefined;
  /** Hard upper bound for `timeout_ms` — model-requested values are clamped. Default: 30000. */
  readonly maxTimeoutMs?: number | undefined;
  /** Whether executed code may make network requests. Default: false. */
  readonly networkAllowed?: boolean | undefined;
  /** OS-level resource limits forwarded to the sandbox. */
  readonly resourceLimits?: ExecutionContext["resourceLimits"] | undefined;
}

export const DEFAULT_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 30_000;

export const EXEC_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: "exec",
  description:
    "Execute code in an isolated sandbox and return the result. The code receives an optional JSON input via the `input` variable and must produce output by returning a value.",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "The code to execute in the sandbox.",
      },
      input: {
        type: "object",
        description: "Optional JSON input passed to the code as the `input` variable.",
      },
      timeout_ms: {
        type: "number",
        description: "Optional execution timeout in milliseconds (clamped to server max).",
      },
    },
    required: ["code"],
  },
};
